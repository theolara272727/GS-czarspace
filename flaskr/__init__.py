from flask import Flask, render_template, jsonify, request, current_app
import csv
import json
import serial 
import threading
import os
import time
import math
import sqlite3
from contextlib import closing
from flask_socketio import SocketIO, emit
from datetime import datetime, timezone
from . import uwb
from .serial_ports import SerialPorts, validate_target
from .telemetry import _normalize_mode_code, _normalize_timestamp, parse_serial_message

CSV_FIELDS = (
    'timestamp', 'collection_timestamp', 'received_timestamp',
    'mode_code', 'tipo_dado', 'valor'
)


def _legacy_database_rows(database_path):
    """Lê o SQLite antigo para que a troca para CSV não apague o histórico."""
    if not os.path.exists(database_path):
        return []

    with closing(sqlite3.connect(database_path)) as conn:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetria'"
        ).fetchone()
        if not table:
            return []

        columns = {
            row[1] for row in conn.execute('PRAGMA table_info(telemetria)').fetchall()
        }
        collection_column = (
            'COALESCE(collection_timestamp, timestamp)'
            if 'collection_timestamp' in columns else 'timestamp'
        )
        received_column = (
            'COALESCE(received_timestamp, timestamp)'
            if 'received_timestamp' in columns else 'timestamp'
        )
        mode_column = 'mode_code' if 'mode_code' in columns else "''"
        order_column = 'id' if 'id' in columns else 'rowid'
        return conn.execute(
            f'''
            SELECT timestamp, {collection_column}, {received_column},
                   {mode_column}, tipo_dado, valor
            FROM telemetria
            ORDER BY {order_column}
            '''
        ).fetchall()


def init_telemetry_csv(app):
    os.makedirs(app.instance_path, exist_ok=True)
    legacy_database_path = os.path.join(app.instance_path, 'historico_voo.db')

    with telemetry_lock:
        if os.path.exists(CSV_PATH) and os.path.getsize(CSV_PATH) > 0:
            return

        rows = _legacy_database_rows(legacy_database_path)
        temporary_path = f'{CSV_PATH}.tmp'
        with open(temporary_path, 'w', encoding='utf-8', newline='') as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
            writer.writeheader()
            for row in rows:
                writer.writerow(dict(zip(CSV_FIELDS, row)))
            csv_file.flush()
            os.fsync(csv_file.fileno())
        os.replace(temporary_path, CSV_PATH)






def _config_path(app):
    return os.path.join(app.instance_path, 'config.json')


def _load_modes(app):
    path = _config_path(app)
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('modes', [])
    except (json.JSONDecodeError, OSError):
        return []


def _save_modes(app, modes):
    path = _config_path(app)
    temporary_path = f'{path}.tmp'
    with open(temporary_path, 'w', encoding='utf-8') as f:
        json.dump({'modes': modes}, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary_path, path)


def _validate_commands(commands):
    if not isinstance(commands, list) or len(commands) > 100:
        raise ValueError('Informe uma lista com até 100 comandos.')
    normalized = []
    for item in commands:
        if not isinstance(item, dict):
            raise ValueError('Cada comando deve ser um objeto.')
        name = item.get('name')
        command = item.get('command')
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError('O nome deve ter entre 1 e 80 caracteres.')
        if not isinstance(command, str) or not command.strip() or len(command) > 1024:
            raise ValueError('O comando deve ter entre 1 e 1024 caracteres.')
        if '\r' in command or '\n' in command:
            raise ValueError('Cadastre um comando por botão, sem quebras de linha.')
        target = validate_target(item.get('target', 'main'), allow_both=True)
        normalized.append({'name': name.strip(), 'command': command.strip(), 'target': target})
    return normalized


def _load_commands(app):
    path = os.path.join(app.instance_path, 'commands.json')
    if not os.path.exists(path):
        return [{'name': 'iniciar', 'command': 'G 00 {timestamp}', 'target': 'main'}]
    with open(path, 'r', encoding='utf-8') as file:
        return _validate_commands(json.load(file)['commands'])


def _save_commands(app, commands):
    path = os.path.join(app.instance_path, 'commands.json')
    temporary_path = f'{path}.tmp'
    with open(temporary_path, 'w', encoding='utf-8') as file:
        json.dump({'commands': commands}, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary_path, path)


#PORTA = 'COM3' #Porta de entrada de dados
BAUD = 115200
PORTA = 'COM14'
# Cada canal abre sua própria conexão sob demanda em serial_ports.py.

socketio = SocketIO()
uwb_processor = uwb.ProcessadorUwb()
uwb_status = {'fonte': 'off', 'conectado': False, 'porta': None, 'mensagem': ''}

CSV_PATH = ""
config_lock = threading.Lock()
telemetry_lock = threading.RLock()


def _validate_modes(modes):
    if not isinstance(modes, list):
        raise ValueError('O campo "modes" deve ser uma lista.')

    normalized = []
    used_codes = set()
    for mode in modes:
        if not isinstance(mode, dict):
            raise ValueError('Cada modo deve ser um objeto.')
        item = dict(mode)
        raw_code = item.get('code', item.get('modeCode'))
        code = _normalize_mode_code(raw_code) if raw_code not in (None, '') else ''
        if code:
            if code in used_codes:
                raise ValueError(f'O código {code} está repetido.')
            used_codes.add(code)
        data_types = item.get('dataTypes', [])
        if not isinstance(data_types, list) or not all(
            isinstance(value, str) and value.strip() for value in data_types
        ):
            raise ValueError(f'Os tipos de dados do modo {code} são inválidos.')
        item['code'] = code
        item.pop('modeCode', None)
        item['dataTypes'] = [value.strip() for value in data_types]
        if len(set(item['dataTypes'])) != len(item['dataTypes']):
            raise ValueError(f'O modo {code or item.get("name", "sem código")} possui tipos repetidos.')
        normalized.append(item)
    return normalized

def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    global CSV_PATH
    CSV_PATH = os.path.join(app.instance_path, 'historico_voo.csv')
    uwb_port = os.environ.get('UWB_SERIAL_PORT', 'COM15').strip()
    uwb_source = os.environ.get('GS_UWB', 'serial' if uwb_port else 'off').strip().lower()
    app.config.from_mapping(
        SECRET_KEY='dev',
        TELEMETRY_CSV=CSV_PATH,
        UWB_SOURCE=uwb_source,
        UWB_SERIAL_PORT=uwb_port,
        UWB_SERIAL_BAUD=int(os.environ.get('UWB_SERIAL_BAUD', uwb.BAUD)),
        UWB_SERIAL_READ_TIMEOUT=0.1,
        UWB_SERIAL_COMMAND_NEWLINE=True,
        UWB_AUTO_ENABLE_CSV=False,
        UWB_TELEMETRY_CSV=os.path.join(app.instance_path, 'historico_uwb.csv'),
        UWB_RAW_LOG=os.path.join(app.instance_path, 'uwb_bruto.csv'),
        UWB_MANEUVER_LOG=os.path.join(app.instance_path, 'manobras.jsonl'),
        SERIAL_PORT=os.environ.get('SERIAL_PORT', PORTA),
        SERIAL_BAUD=int(os.environ.get('SERIAL_BAUD', BAUD)),
        SERIAL_COMMAND_NEWLINE=True,
        SERIAL_READ_TIMEOUT=1,
        SERIAL_READER_ENABLED=True,
        # Temporário: emite telemetria simulada enquanto não há hardware conectado.
        SYNTHETIC_TELEMETRY_ENABLED=False,
        SYNTHETIC_TELEMETRY_INTERVAL=1.0,
    )
    app.config.from_mapping(test_config)
    if app.config['UWB_SOURCE'] == 'simulado':
        app.config['UWB_SOURCE'] = 'off'
    if app.config['UWB_SOURCE'] not in ('off', 'serial', 'simulado'):
        raise ValueError('GS_UWB deve ser off, serial ou simulado.')
    if (app.config['UWB_SOURCE'] == 'serial' and not app.config['UWB_SERIAL_PORT']
            and app.config.get('UWB_SERIAL_CONNECTION') is None):
        raise ValueError('Configure UWB_SERIAL_PORT para usar a segunda porta serial.')
    app.extensions['serial_ports'] = SerialPorts(app.config)
    socketio.init_app(app)
    os.makedirs(app.instance_path, exist_ok=True)

    @app.route('/')
    def base():
        return render_template('base.html')

    @app.route('/modes', methods=['GET'])
    def get_modes():
        return jsonify({'modes': _load_modes(app)})

    @app.route('/modes', methods=['POST'])
    def save_modes_route():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or 'modes' not in payload:
            return jsonify({
                'status': 'error',
                'message': 'A requisição deve conter um JSON válido com o campo "modes".'
            }), 400
        try:
            modes = _validate_modes(payload['modes'])
        except ValueError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 400
        with config_lock:
            _save_modes(app, modes)
        return jsonify({'status': 'ok', 'modes': modes})

    @app.route('/commands', methods=['GET'])
    def get_commands():
        try:
            with config_lock:
                commands = _load_commands(app)
            return jsonify({'commands': commands})
        except (OSError, ValueError, KeyError, TypeError):
            return jsonify({'message': 'Não foi possível carregar os comandos.'}), 500

    @app.route('/commands', methods=['POST'])
    def save_commands_route():
        payload = request.get_json(silent=True)
        try:
            commands = _validate_commands(
                payload.get('commands') if isinstance(payload, dict) else None
            )
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        try:
            with config_lock:
                _save_commands(app, commands)
        except OSError:
            return jsonify({'message': 'Não foi possível salvar os comandos.'}), 500
        return jsonify({'status': 'ok', 'commands': commands})

    @app.route('/telemetry-availability', methods=['GET'])
    def telemetry_availability_route():
        mode_code = request.args.get('modeCode')
        try:
            return jsonify(query_telemetry_availability(mode_code))
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except (OSError, csv.Error):
            return jsonify({'message': 'Não foi possível consultar a disponibilidade.'}), 500


    @app.route('/uwb/estado', methods=['GET'])
    def uwb_state_route():
        return jsonify({'status': uwb_status, 'manobra': uwb_processor.ultimo_resultado,
                        'telemetria': uwb_processor.telemetria()})

    CSV_PATH = app.config['TELEMETRY_CSV']
    init_telemetry_csv(app)

    if app.config['UWB_SOURCE'] == 'serial':
        uwb_thread = threading.Thread(
            target=run_uwb_loop, args=(app,), name='UwbThread', daemon=True
        )
        uwb_thread.start()
    if app.config['SYNTHETIC_TELEMETRY_ENABLED']:
        synthetic_thread = threading.Thread(
            target=emit_synthetic_data,
            args=(app,),
            name='SyntheticTelemetryThread',
            daemon=True,
        )
        synthetic_thread.start()
    elif app.config['SERIAL_READER_ENABLED']:
        read_thread = threading.Thread(target=emit_data, args=(app,), name="ReadSerialDataThread")
        read_thread.daemon = True
        read_thread.start()

    return app


def read_serial(app):
    """Interpreta telemetria e encaminha outras respostas ao terminal."""
    raw_message, source = app.extensions['serial_ports'].readline('main')
    if not raw_message:
        return None
    try:
        with config_lock:
            modes = _validate_modes(_load_modes(app))
        telemetry = parse_serial_message(raw_message, modes)
        telemetry['serialSource'] = source
        return telemetry
    except (ValueError, TypeError, OverflowError):
        # Respostas fora do protocolo aparecem somente no terminal.
        socketio.emit('serial_received', {
            'text': raw_message.decode('utf-8', errors='replace'),
            'hex': raw_message.hex(),
            **source,
        })
        return None
# tempo_simulacao = 0.0

# def read_serial(app):
#     global tempo_simulacao
    
#     # Pausa de 0.5 segundos para simular a taxa de amostragem
#     time.sleep(0.5)
#     tempo_simulacao += 0.05 
    
#     t = tempo_simulacao

#     # Simulação dos Aviões
#     lat1 = -19.9167 + 0.05 * math.cos(t)
#     lng1 = -43.9345 + 0.05 * math.sin(t)
#     alt1 = 15000 + 3000 * math.sin(t * 0.5)
#     speed1 = 492 + 20 * math.sin(t)
#     track1 = (math.atan2(math.cos(t), -math.sin(t)) * (180 / math.pi) + 360) % 360
    
#     lat2 = -19.9167 + 0.02 * math.cos(t * 1.5 + 1.2)
#     lng2 = -43.9345 + 0.02 * math.sin(t * 1.5 + 1.2)
#     alt2 = 8000 + 1000 * math.cos(t * 0.8)
#     speed2 = 352 + 15 * math.cos(t * 1.5)
#     track2 = (math.atan2(math.cos(t * 1.5 + 1.2), -math.sin(t * 1.5 + 1.2)) * (180 / math.pi) + 360) % 360

#     from datetime import datetime, timezone
#     now = datetime.now(timezone.utc).isoformat()

#     # Estrutura com os novos campos hex, speed e track
#     return {
#         'timestamp': now,
#         'receivedTimestamp': now,
#         'modeCode': '0x01', # ATENÇÃO: Verifique o código selecionado no seu painel
#         'modeName': 'Simulacao Map',
#         'values': {
#             'avioes': [
#                 {
#                     "hex": "e49763",
#                     "id": "TAM3628", 
#                     "lat": round(lat1, 5), 
#                     "lng": round(lng1, 5), 
#                     "altitude": int(alt1),
#                     "speed": int(speed1),
#                     "track": int(track1)
#                 },
#                 {
#                     "hex": "e49f5a",
#                     "id": "AZU6419", 
#                     "lat": round(lat2, 5), 
#                     "lng": round(lng2, 5), 
#                     "altitude": int(alt2),
#                     "speed": int(speed2),
#                     "track": int(track2)
#                 }
#             ]
#         }
#     }




def emit_data(app):
    while True:
        try:
            dados = read_serial(app)
            if dados is None:
                continue
            save_telemetry(dados)
            socketio.emit('new_data', dados)
        except (serial.SerialException, OSError) as error:
            app.logger.warning('Falha na leitura serial: %s', error)
            time.sleep(2)


def _synthetic_value(data_type, sample_number, position):
    """Gera uma curva previsível, mas com variação suficiente para testar gráficos."""
    name = data_type.lower()
    wave = math.sin(sample_number / 6 + position) * 0.5

    if any(term in name for term in ('dist', 'alt', 'altura')):
        return round(500 + (sample_number * 1.8) + (wave * 25), 2)
    if any(term in name for term in ('temp', 'temperatura')):
        return round(24 + (wave * 6), 2)
    if any(term in name for term in ('press', 'pressao', 'pressão')):
        return round(1013.25 + (wave * 12), 2)
    if any(term in name for term in ('volt', 'bateria')):
        return round(12.4 + (wave * 0.35), 3)
    if 'icao' in name:
        return float(891000 + (sample_number % 500))

    return round(50 + (position * 10) + (wave * 20), 2)


def build_synthetic_telemetry(app, sample_number):
    """Monta um payload idêntico ao produzido pela leitura da porta serial."""
    with config_lock:
        modes = _validate_modes(_load_modes(app))

    mode = next((item for item in modes if item.get('dataTypes')), None)
    if mode is None:
        return None

    data_types = mode['dataTypes']
    values = {
        data_type: _synthetic_value(data_type, sample_number, index)
        for index, data_type in enumerate(data_types)
    }
    now = datetime.now(timezone.utc).isoformat()
    return {
        'timestamp': now,
        'receivedTimestamp': now,
        'modeCode': mode['code'],
        'modeName': mode.get('name', mode['code']),
        'values': values,
    }


def emit_synthetic_data(app):
    """Emissor temporário para desenvolvimento da interface e dos widgets."""
    sample_number = 0
    interval = float(app.config['SYNTHETIC_TELEMETRY_INTERVAL'])

    while True:
        try:
            dados = build_synthetic_telemetry(app, sample_number)
            if dados is not None:
                save_telemetry(dados)
                socketio.emit('new_data', dados)
                sample_number += 1
        except (OSError, ValueError, csv.Error) as error:
            app.logger.warning('Falha ao gerar telemetria sintética: %s', error)

        time.sleep(max(interval, 0.1))

# ============================ CONSTELAÇÃO UWB ================================

def _set_uwb_status(**changes):
    uwb_status.update(changes)
    socketio.emit('uwb_status', dict(uwb_status))


def _uwb_read_line(app, buffer):
    """Lê o que houver na serial e devolve as linhas completas (sem quebrar medidas ao meio)."""
    chunk, source = app.extensions['serial_ports'].readline('uwb')
    if chunk:
        buffer.extend(chunk)
    lines = []
    while b'\n' in buffer:
        raw, _, rest = bytes(buffer).partition(b'\n')
        buffer[:] = rest
        line = raw.decode('utf-8', errors='replace').strip()
        lines.append(line)
        try:
            with config_lock:
                modes = _validate_modes(_load_modes(app))
        except ValueError:
            modes = []
        packet = uwb.parse_serial_line(line, modes)
        if packet is not None:
            uwb_processor.processa_telemetria(packet)
            _append_line(app.config['UWB_RAW_LOG'], packet['raw'])
            socketio.emit('serial_telemetry', {
                'timestamp': packet['timestamp'],
                'receivedTimestamp': packet['receivedTimestamp'],
                'deviceTimestamp': packet['deviceTimestamp'],
                'modeCode': packet['modeCode'],
                'modeName': packet['modeName'],
                'values': packet['values'],
                'serialSource': source,
            })
        else:
            socketio.emit('serial_received', {
                'text': (raw + b'\n').decode('utf-8', errors='replace'),
                'hex': (raw + b'\n').hex(),
                **source,
            })
    return lines


def _uwb_enable_csv(app, buffer):
    """Liga o modo CSV da GS (o comando V alterna ON/OFF). Devolve as linhas lidas no caminho."""
    seen = []
    for _ in range(2):
        app.extensions['serial_ports'].write('uwb', b'V\n')
        started = time.time()
        while time.time() - started < 2.0:
            for line in _uwb_read_line(app, buffer):
                seen.append(line)
                if 'CSV bruto: ON' in line:
                    return True, seen
                if 'CSV bruto: OFF' in line:
                    break  # estava ligado e desligou: manda V de novo
            else:
                continue
            break
    return False, seen


def _uwb_serial_lines(app):
    """Gera as linhas da GS real, reconectando sozinho se a porta cair."""
    port = app.config['UWB_SERIAL_PORT']
    ports = app.extensions['serial_ports']
    buffer = bytearray()
    while True:
        try:
            ports.open('uwb')
            revision = ports.revision('uwb')
            _set_uwb_status(fonte='serial', conectado=True, porta=port,
                            mensagem=f'Conectado em {port}. Aguardando a GS reiniciar...')
            time.sleep(2.5)  # abrir a porta reseta o ESP32
            if app.config['UWB_AUTO_ENABLE_CSV']:
                ok, seen = _uwb_enable_csv(app, buffer)
                _set_uwb_status(mensagem='Modo CSV da GS ligado.' if ok else
                                "Não confirmei o modo CSV. Envie 'V' pela porta UWB se não chegarem dados.")
                yield from seen
            else:
                _set_uwb_status(mensagem='Recebendo telemetria DW1000.')
            while True:
                if ports.revision('uwb') != revision:
                    raise serial.SerialException('Conexão UWB alterada; reinicializando recepção.')
                lines = _uwb_read_line(app, buffer)
                if not lines:
                    yield None
                yield from lines
        except (serial.SerialException, OSError) as error:
            ports.close('uwb')
            buffer.clear()
            _set_uwb_status(fonte='serial', conectado=False, porta=port,
                            mensagem=f'Sem conexão com {port}: {error}. Tentando de novo...')
            app.logger.warning('UWB: falha na porta %s: %s', port, error)
            time.sleep(2)
            yield None


def _append_line(path, text):
    try:
        with open(path, 'a', encoding='utf-8') as log_file:
            log_file.write(text + '\n')
    except OSError as error:
        print(f'Erro ao gravar {path}: {error}')


def run_uwb_evaluation(app, forcar=False):
    try:
        resultado = uwb_processor.avaliar(forcar=forcar)
    except Exception:  # a thread de leitura não pode morrer por um erro de análise
        app.logger.exception('UWB: erro ao avaliar as manobras')
        return None
    resultado['fonte'] = dict(uwb_status)
    socketio.emit('manobra', resultado)
    if any(sat.get('estrategias') and not sat.get('reaproveitada')
           for sat in resultado['satelites'].values()):
        _append_line(app.config['UWB_MANEUVER_LOG'], json.dumps(resultado, ensure_ascii=False))
    return resultado


def run_uwb_loop(app):
    source = app.config['UWB_SOURCE']
    if source != 'serial':
        return
    lines = _uwb_serial_lines(app)

    next_telemetry = time.time() + uwb.PERIODO_TELEMETRIA_S
    next_evaluation = time.time() + uwb.PERIODO_S
    for _line in lines:
        now = time.time()
        if now >= next_telemetry:
            dados = uwb_processor.telemetria()
            if dados:
                dados['serialSource'] = {
                    'target': 'uwb',
                    'port': app.config['UWB_SERIAL_PORT'] if source == 'serial' else None,
                    'baud': app.config['UWB_SERIAL_BAUD'],
                    'simulated': source == 'simulado',
                }
                save_telemetry(dados, csv_path=app.config['UWB_TELEMETRY_CSV'])
                socketio.emit('uwb_data', dados)
            next_telemetry = now + uwb.PERIODO_TELEMETRIA_S
        if now >= next_evaluation:
            run_uwb_evaluation(app)
            next_evaluation = time.time() + uwb.PERIODO_S


@socketio.on('manobra_solicitar')
def handle_maneuver_request(payload):
    forcar = bool(payload.get('forcar')) if isinstance(payload, dict) else False
    if current_app.config.get('UWB_SOURCE') != 'serial':
        return {'ok': False, 'message': 'A constelação UWB está desligada (GS_UWB=off).'}
    resultado = run_uwb_evaluation(current_app._get_current_object(), forcar=forcar)
    if resultado is None:
        return {'ok': False, 'message': 'Falha ao calcular as manobras (veja o terminal do Flask).'}
    return {'ok': True, 'message': 'Manobras recalculadas.'}


@socketio.on('connect')
def init_connection():
    emit('connection_status', {'connected': True})
    emit('uwb_status', dict(uwb_status))
    if uwb_processor.ultimo_resultado is not None:
        emit('manobra', uwb_processor.ultimo_resultado)


@socketio.on('serial_command')
def handle_serial_command(payload):
    command = payload.get('command', '') if isinstance(payload, dict) else ''
    if not isinstance(command, str) or not command.strip():
        return {'ok': False, 'message': 'Digite um comando antes de enviar.'}
    if len(command) > 1024:
        return {'ok': False, 'message': 'O comando deve possuir no máximo 1024 caracteres.'}

    try:
        target = validate_target(payload.get('target', 'main'), allow_both=True)
    except ValueError as error:
        return {'ok': False, 'message': str(error)}

    command = command.rstrip('\r\n')
    targets = ('main', 'uwb') if target == 'both' else (target,)
    results = []
    for destination in targets:
        newline_key = 'SERIAL_COMMAND_NEWLINE' if destination == 'main' else 'UWB_SERIAL_COMMAND_NEWLINE'
        encoded_command = (command + ('\n' if current_app.config.get(newline_key, True) else '')).encode('utf-8')
        try:
            bytes_written, source = current_app.extensions['serial_ports'].write(destination, encoded_command)
            port, baud = source['port'], source['baud']
            results.append({
                'target': destination,
                'ok': True,
                'message': f'Escrito em {port} a {baud} baud ({bytes_written} bytes)',
            })
        except (serial.SerialException, OSError) as error:
            results.append({
                'target': destination,
                'ok': False,
                'message': f'Falha ao enviar pela porta serial: {error}',
            })
    labels = {'main': 'Principal', 'uwb': 'DW1000'}
    return {
        'ok': all(result['ok'] for result in results),
        'message': results[0]['message'] if target != 'both' else '; '.join(
            f"{labels[result['target']]}: {result['message']}" for result in results
        ),
        'results': results,
    }



def save_telemetry(dados_recebidos, csv_path=None):
    csv_path = CSV_PATH if csv_path is None else csv_path
    try:
        received_at = dados_recebidos.get(
            'receivedTimestamp', datetime.now(timezone.utc).isoformat()
        )
        collected_at = dados_recebidos.get('timestamp', received_at)
        mode_code = dados_recebidos.get('modeCode')
        telemetry = dados_recebidos.get('values', {})
        
        rows = []
        for tipo, valor in telemetry.items():
            try:
                valor_numerico = float(valor)
                rows.append({
                    'timestamp': collected_at,
                    'collection_timestamp': collected_at,
                    'received_timestamp': received_at,
                    'mode_code': mode_code or '',
                    'tipo_dado': tipo,
                    'valor': valor_numerico,
                })
            except (TypeError, ValueError):
                continue

        if not rows:
            return

        with telemetry_lock:
            needs_header = not os.path.exists(csv_path) or os.path.getsize(csv_path) == 0
            with open(csv_path, 'a', encoding='utf-8', newline='') as csv_file:
                writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
                if needs_header:
                    writer.writeheader()
                writer.writerows(rows)
                csv_file.flush()
                os.fsync(csv_file.fileno())
        
    except Exception as e:
        print(f"Erro ao salvar no arquivo CSV: {e}")

@socketio.on('time_series')
def handle_time_series(dados_recebidos):
    dados_recebidos = dados_recebidos if isinstance(dados_recebidos, dict) else {}
    request_id = dados_recebidos.get('requestId')
    try:
        start_utc = dados_recebidos.get('start')
        end_utc = dados_recebidos.get('end')
        mode_code = dados_recebidos.get('modeCode')
        result = query_timeframe(start_utc, end_utc, mode_code)
        result['requestId'] = request_id
        emit('historical_data', result)
    except (TypeError, ValueError) as error:
        emit('historical_error', {'message': str(error), 'requestId': request_id})
    except (OSError, csv.Error):
        emit('historical_error', {
            'message': 'Não foi possível consultar o arquivo de telemetria.',
            'requestId': request_id
        })

def _parse_iso_datetime(value, field_name):
    if not isinstance(value, str) or not value:
        raise ValueError(f'O campo "{field_name}" é obrigatório.')

    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError(f'O campo "{field_name}" possui uma data inválida.') from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def query_timeframe(start_utc, end_utc, mode_code=None):
    start = _parse_iso_datetime(start_utc, 'start')
    end = _parse_iso_datetime(end_utc, 'end')
    if start > end:
        raise ValueError('A data inicial deve ser anterior à data final.')

    start_iso = start.isoformat()
    end_iso = end.isoformat()

    mode_code = _normalize_mode_code(mode_code) if mode_code else None
    rows = []
    with telemetry_lock:
        with open(CSV_PATH, 'r', encoding='utf-8', newline='') as csv_file:
            for row_number, row in enumerate(csv.DictReader(csv_file)):
                collection_timestamp = row.get('collection_timestamp') or row.get('timestamp')
                try:
                    collected_at = _parse_iso_datetime(collection_timestamp, 'timestamp')
                    value = float(row['valor'])
                except (KeyError, TypeError, ValueError):
                    continue
                row_mode_code = row.get('mode_code') or None
                if start <= collected_at <= end and (not mode_code or row_mode_code == mode_code):
                    rows.append((
                        collected_at,
                        row_number,
                        collection_timestamp,
                        row.get('received_timestamp') or collection_timestamp,
                        row_mode_code,
                        row.get('tipo_dado'),
                        value,
                    ))

    rows.sort(key=lambda row: (row[0], row[1]))

    samples_by_timestamp = {}
    for _, _, timestamp, received_timestamp, mode_code, data_type, value in rows:
        sample_key = (timestamp, received_timestamp, mode_code)
        sample = samples_by_timestamp.setdefault(sample_key, {
            'timestamp': timestamp,
            'collectionTimestamp': timestamp,
            'receivedTimestamp': received_timestamp,
            'modeCode': mode_code,
        })
        sample[str(data_type)] = value

    samples = list(samples_by_timestamp.values())
    return {
        'start': start_iso,
        'end': end_iso,
        'count': len(samples),
        'samples': samples
    }


def query_telemetry_availability(mode_code=None):
    mode_code = _normalize_mode_code(mode_code) if mode_code else None
    timestamps = set()
    with telemetry_lock:
        with open(CSV_PATH, 'r', encoding='utf-8', newline='') as csv_file:
            for row in csv.DictReader(csv_file):
                timestamp = row.get('collection_timestamp') or row.get('timestamp')
                if timestamp and (not mode_code or row.get('mode_code') == mode_code):
                    try:
                        _parse_iso_datetime(timestamp, 'timestamp')
                    except (TypeError, ValueError):
                        continue
                    timestamps.add(timestamp)

    ordered_timestamps = sorted(timestamps, key=lambda value: _parse_iso_datetime(value, 'timestamp'))
    samples_by_day = {}
    for timestamp in ordered_timestamps:
        day = _parse_iso_datetime(timestamp, 'timestamp').date().isoformat()
        samples_by_day[day] = samples_by_day.get(day, 0) + 1

    return {
        'modeCode': mode_code,
        'start': ordered_timestamps[0] if ordered_timestamps else None,
        'end': ordered_timestamps[-1] if ordered_timestamps else None,
        'days': [
            {'date': day, 'count': count}
            for day, count in samples_by_day.items()
        ]
    }
    

if __name__ == '__main__':
    app = create_app()
