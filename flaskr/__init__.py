from flask import Flask, render_template, jsonify, request, current_app
import json
import re
import serial 
import threading
import os
import time
import sqlite3
from contextlib import closing
from flask_socketio import SocketIO, emit
from datetime import datetime, timezone

#Inicializa base de dados
def init_db(app):
    os.makedirs(app.instance_path, exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as conn:
        with conn:
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS telemetria(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    collection_timestamp TEXT,
                    received_timestamp TEXT,
                    mode_code TEXT,
                    tipo_dado TEXT NOT NULL,
                    valor REAL NOT NULL
                )
            ''')
            existing_columns = {
                row[1] for row in cursor.execute('PRAGMA table_info(telemetria)').fetchall()
            }
            for column in ('collection_timestamp', 'received_timestamp', 'mode_code'):
                if column not in existing_columns:
                    cursor.execute(f'ALTER TABLE telemetria ADD COLUMN {column} TEXT')
            cursor.execute('''
                UPDATE telemetria
                SET collection_timestamp = COALESCE(collection_timestamp, timestamp),
                    received_timestamp = COALESCE(received_timestamp, timestamp)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_telemetria_timestamp
                ON telemetria(timestamp)
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_telemetria_collection_mode
                ON telemetria(collection_timestamp, mode_code)
            ''')
            conn.commit()






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


#PORTA = 'COM3' #Porta de entrada de dados
BAUD = 9600 
PORTA = 'COM3'
porta_serial = None
thread = None
try:
    porta_serial = serial.Serial(PORTA, BAUD) #Configura a porta serial
    porta_serial.timeout = 2
except serial.SerialException as exc:
    porta_serial = None
    print(f"Aviso: não foi possível abrir a porta serial {PORTA}: {exc}")

socketio = SocketIO()

DB_PATH = ""
serial_connection = None
serial_lock = threading.Lock()
config_lock = threading.Lock()


def _normalize_mode_code(value):
    if isinstance(value, int) and not isinstance(value, bool):
        number = value
    elif isinstance(value, str):
        candidate = value.strip()
        if not re.fullmatch(r'(?:0[xX])?[0-9a-fA-F]+', candidate):
            raise ValueError('O código do modo deve ser hexadecimal (ex.: 0x01).')
        number = int(candidate, 16)
    else:
        raise ValueError('O código do modo é obrigatório.')
    if number < 0:
        raise ValueError('O código do modo não pode ser negativo.')
    return f'0x{number:X}'


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
    global DB_PATH 
    DB_PATH = os.path.join(app.instance_path, 'historico_voo.db')
    app.config.from_mapping(
        SECRET_KEY='dev',
        DATABASE=os.path.join(app.instance_path, 'flaskr.sqlite'),
        SERIAL_PORT=os.environ.get('SERIAL_PORT', 'COM3'),
        SERIAL_BAUD=int(os.environ.get('SERIAL_BAUD', BAUD)),
        SERIAL_COMMAND_NEWLINE=True,
        SERIAL_READER_ENABLED=True,
    )
    app.config.from_mapping(test_config)
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

    @app.route('/telemetry-availability', methods=['GET'])
    def telemetry_availability_route():
        mode_code = request.args.get('modeCode')
        try:
            return jsonify(query_telemetry_availability(mode_code))
        except ValueError as error:
            return jsonify({'message': str(error)}), 400
        except sqlite3.Error:
            return jsonify({'message': 'Não foi possível consultar a disponibilidade.'}), 500


    init_db(app)

    if app.config['SERIAL_READER_ENABLED']:
        read_thread = threading.Thread(target=emit_data, args=(app,), name="ReadSerialDataThread")
        read_thread.daemon = True
        read_thread.start()

    return app


def _normalize_timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    if not isinstance(value, str) or not value.strip():
        raise ValueError('A timestamp de coleta é obrigatória.')
    candidate = value.strip()
    if re.fullmatch(r'\d+(?:\.\d+)?', candidate):
        numeric_value = float(candidate)
        seconds = numeric_value / 1000 if numeric_value > 10_000_000_000 else numeric_value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    parsed = datetime.fromisoformat(candidate.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def parse_serial_message(raw_message, modes):
    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode('utf-8')
    if not isinstance(raw_message, str) or not raw_message.strip():
        raise ValueError('Mensagem serial vazia.')

    text = raw_message.strip()
    if text.startswith('{'):
        message = json.loads(text)
        collected_at = message.get('timestamp', message.get('collectedAt'))
        mode_code = message.get('modeCode', message.get('mode', message.get('code')))
        values = message.get('values', message.get('data'))
    else:
        fields = text.split()
        if len(fields) < 3:
            raise ValueError('Formato esperado: timestamp código_hex valor1 valor2 ...')
        collected_at, mode_code, *values = fields

    if not isinstance(values, list):
        raise ValueError('O campo "values" deve ser uma lista.')
    normalized_code = _normalize_mode_code(mode_code)
    mode = next((item for item in modes if item.get('code') == normalized_code), None)
    if mode is None:
        raise ValueError(f'Não existe configuração para o modo {normalized_code}.')
    data_types = mode.get('dataTypes', [])
    if len(values) != len(data_types):
        raise ValueError(
            f'O modo {normalized_code} espera {len(data_types)} valores, mas recebeu {len(values)}.'
        )
    try:
        telemetry = {name: float(value) for name, value in zip(data_types, values)}
    except (TypeError, ValueError) as error:
        raise ValueError('Todos os valores de telemetria devem ser numéricos.') from error

    return {
        'timestamp': _normalize_timestamp(collected_at),
        'receivedTimestamp': datetime.now(timezone.utc).isoformat(),
        'modeCode': normalized_code,
        'modeName': mode.get('name', normalized_code),
        'values': telemetry,
    }


def read_serial(app):
    with app.app_context():
        with serial_lock:
            connection = _get_serial_connection()
            raw_message = connection.readline()
    if not raw_message:
        return None
    with config_lock:
        modes = _validate_modes(_load_modes(app))
    return parse_serial_message(raw_message, modes)


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
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            app.logger.warning('Mensagem serial ignorada: %s', error)

@socketio.on('connect')
def init_connection():
    emit('connection_status', {'connected': True})


def _get_serial_connection():
    global serial_connection

    configured_connection = current_app.config.get('SERIAL_CONNECTION')
    if configured_connection is not None:
        return configured_connection

    port = current_app.config['SERIAL_PORT']
    baud = current_app.config['SERIAL_BAUD']
    if serial_connection is None or not serial_connection.is_open:
        serial_connection = serial.Serial(
            port=port,
            baudrate=baud,
            timeout=1,
            write_timeout=1
        )
    return serial_connection


@socketio.on('serial_command')
def handle_serial_command(payload):
    command = payload.get('command', '') if isinstance(payload, dict) else ''
    if not isinstance(command, str) or not command.strip():
        return {'ok': False, 'message': 'Digite um comando antes de enviar.'}
    if len(command) > 1024:
        return {'ok': False, 'message': 'O comando deve possuir no máximo 1024 caracteres.'}

    command = command.rstrip('\r\n')
    if current_app.config.get('SERIAL_COMMAND_NEWLINE', True):
        command += '\n'

    try:
        encoded_command = command.encode('utf-8')
        with serial_lock:
            connection = _get_serial_connection()
            bytes_written = connection.write(encoded_command)
            connection.flush()
        return {
            'ok': True,
            'message': f'Comando enviado ({bytes_written} bytes).'
        }
    except (serial.SerialException, OSError) as error:
        return {
            'ok': False,
            'message': f'Falha ao enviar pela porta serial: {error}'
        }



def save_telemetry(dados_recebidos):
    try:
        received_at = dados_recebidos.get(
            'receivedTimestamp', datetime.now(timezone.utc).isoformat()
        )
        collected_at = dados_recebidos.get('timestamp', received_at)
        mode_code = dados_recebidos.get('modeCode')
        telemetry = dados_recebidos.get('values', {})
        
        # 2. Connect and save
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        for tipo, valor in telemetry.items():
            try:
                valor_numerico = float(valor)
                
                cursor.execute('''
                    INSERT INTO telemetria (
                        timestamp, collection_timestamp, received_timestamp,
                        mode_code, tipo_dado, valor
                    ) VALUES (?, ?, ?, ?, ?, ?)
                ''', (collected_at, collected_at, received_at, mode_code, tipo, valor_numerico))
                
            except ValueError:
                continue 
                
        conn.commit()
        conn.close()
        
    except Exception as e:
        print(f"Erro ao salvar no banco: {e}")

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
    except sqlite3.Error:
        emit('historical_error', {
            'message': 'Não foi possível consultar o banco de telemetria.',
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
    mode_filter = ' AND mode_code = ?' if mode_code else ''
    parameters = (start_iso, end_iso, mode_code) if mode_code else (start_iso, end_iso)
    with closing(sqlite3.connect(DB_PATH)) as conn:
        rows = conn.execute(
                f'''
                SELECT collection_timestamp, received_timestamp, mode_code, tipo_dado, valor
                FROM telemetria
                WHERE collection_timestamp BETWEEN ? AND ?
                {mode_filter}
                ORDER BY collection_timestamp ASC, id ASC
                ''',
                parameters
            ).fetchall()

    samples_by_timestamp = {}
    for timestamp, received_timestamp, mode_code, data_type, value in rows:
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
    mode_filter = 'WHERE mode_code = ?' if mode_code else ''
    parameters = (mode_code,) if mode_code else ()

    with closing(sqlite3.connect(DB_PATH)) as conn:
        bounds = conn.execute(
            f'''
            SELECT MIN(collection_timestamp), MAX(collection_timestamp)
            FROM telemetria
            {mode_filter}
            ''',
            parameters
        ).fetchone()
        day_rows = conn.execute(
            f'''
            SELECT substr(collection_timestamp, 1, 10) AS collection_day,
                   COUNT(DISTINCT collection_timestamp) AS sample_count
            FROM telemetria
            {mode_filter}
            GROUP BY collection_day
            ORDER BY collection_day
            ''',
            parameters
        ).fetchall()

    start, end = bounds
    return {
        'modeCode': mode_code,
        'start': start,
        'end': end,
        'days': [
            {'date': day, 'count': count}
            for day, count in day_rows
            if day
        ]
    }
    

if __name__ == '__main__':
    app = create_app()
