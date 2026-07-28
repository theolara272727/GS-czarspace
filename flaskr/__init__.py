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



#Inicializa base de dados
def init_db(app):
    os.makedirs(app.instance_path, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS telemetria_detalhada (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            tipo_dado TEXT NOT NULL,
            valor REAL NOT NULL
        )
    ''')
    conn.commit()
    conn.close()






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
    socketio.init_app(app)
    app.config.from_mapping(
        SECRET_KEY='dev',
        DATABASE=os.path.join(app.instance_path, 'flaskr.sqlite'),
    )
    app.config.from_mapping(test_config)

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

    read_thread = threading.Thread(target=read_serial, name="ReadSerialDataThread")
    read_thread.daemon = True
    read_thread.start()
    init_db(app)
    return app

def read_serial():
    contador = 0
    while True:
        contador += 1
        time.sleep(2)
        
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
        # serial_input = porta_serial.readline()
        socketio.emit('new_data', dados)

@socketio.on('connect')
def init_connection():
    socketio.start_background_task(read_serial)



@socketio.on('save_telemetry')
def handle_save_telemetry(dados_recebidos):
    try:
       
        timestamp_atual = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        for tipo, valor in dados_recebidos.items():
            try:
                valor_numerico = float(valor)
                
                cursor.execute('''
                    INSERT INTO telemetria_detalhada (timestamp, tipo_dado, valor) 
                    VALUES (?, ?, ?)
                ''', (timestamp_atual, tipo, valor_numerico))
                
            except ValueError:
                continue 
                
        conn.commit()
        conn.close()
        
    except Exception as e:
        print(f"Erro ao salvar no banco: {e}")


if __name__ == '__main__':
    app = create_app()
    socketio.run(app)
