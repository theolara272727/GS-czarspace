from flask import Flask, render_template, jsonify, request
import json
import serial 
import threading
import os
import time
import random
import sqlite3
from datetime import datetime
from flask_socketio import SocketIO, send, emit
import sqlite3
import os
import click
from datetime import datetime, timezone, timedelta

#Inicializa base de dados
def init_db(app):
    os.makedirs(app.instance_path, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS telemetria(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    tipo_dado TEXT NOT NULL,
                    valor REAL NOT NULL
                )
            ''')
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_telemetria_timestamp
                ON telemetria(timestamp)
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
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'modes': modes}, f, ensure_ascii=False, indent=2)


#PORTA = 'COM3' #Porta de entrada de dados
BAUD = 9600 

#porta_serial = serial.Serial(PORTA, BAUD) #Configura a porta serial
#   porta_serial.timeout = 2
socketio = SocketIO()

DB_PATH = ""

def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    global DB_PATH 
    DB_PATH = os.path.join(app.instance_path, 'historico_voo.db')
    app.config.from_mapping(
        SECRET_KEY='dev',
        DATABASE=os.path.join(app.instance_path, 'flaskr.sqlite'),
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
        payload = request.get_json(silent=True) or {}
        modes = payload.get('modes', [])
        _save_modes(app, modes)
        return jsonify({'status': 'ok', 'modes': modes})


    read_thread = threading.Thread(target=emit_data, name="ReadSerialDataThread")
    read_thread.daemon = True
    read_thread.start()

    init_db(app)

    return app


#Por enqt só manda uns trem aleatorio pq nn estamos lendo a porta serial de verdade
def read_serial():
        contador =random.randint(-10,10)
        dados = [
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),
            1000 + (contador * 5),

        ]
        current_time = datetime.now(timezone.utc).isoformat()
        return {
            "timestamp": current_time,
            "values": dados
            }
def emit_data():
    while True:
        time.sleep(2)
        
        dados = read_serial()
        # serial_input = porta_serial.readline()
        socketio.emit('new_data', dados)

@socketio.on('connect')
def init_connection():
    emit('connection_status', {'connected': True})



@socketio.on('save_telemetry')
def handle_save_telemetry(dados_recebidos):

    try:
        fallback_time = datetime.now(timezone.utc).isoformat()
        timestamp_atual = dados_recebidos.get('timestamp', fallback_time)
        dados_recebidos = dados_recebidos.get('telemetry', {})
        
        # 2. Connect and save
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        for tipo, valor in dados_recebidos.items():
            try:
                valor_numerico = float(valor)
                
                cursor.execute('''
                    INSERT INTO telemetria (timestamp, tipo_dado, valor) 
                    VALUES (?, ?, ?)
                ''', (timestamp_atual, tipo, valor_numerico))
                
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
        result = query_timeframe(start_utc, end_utc)
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


def query_timeframe(start_utc, end_utc):
    start = _parse_iso_datetime(start_utc, 'start')
    end = _parse_iso_datetime(end_utc, 'end')
    if start > end:
        raise ValueError('A data inicial deve ser anterior à data final.')

    start_iso = start.isoformat()
    end_iso = end.isoformat()

    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            '''
            SELECT timestamp, tipo_dado, valor
            FROM telemetria
            WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC, id ASC
            ''',
            (start_iso, end_iso)
        ).fetchall()

    samples_by_timestamp = {}
    for timestamp, data_type, value in rows:
        sample = samples_by_timestamp.setdefault(timestamp, {'timestamp': timestamp})
        sample[str(data_type)] = value

    samples = list(samples_by_timestamp.values())
    return {
        'start': start_iso,
        'end': end_iso,
        'count': len(samples),
        'samples': samples
    }
    

if __name__ == '__main__':
    app = create_app()
