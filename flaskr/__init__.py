from flask import (Flask,render_template)
import serial 
import threading
import os
import time
from flask_socketio import SocketIO, send, emit


PORTA = 'COM1' #Porta de entrada de dados
BAUD = 9600 

porta_serial = None
thread = None
try:
    porta_serial = serial.Serial(PORTA, BAUD) #Configura a porta serial
    porta_serial.timeout = 2
except serial.SerialException as exc:
    porta_serial = None
    print(f"Aviso: não foi possível abrir a porta serial {PORTA}: {exc}")

socketio = SocketIO()

def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
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
    

    read_thread = threading.Thread(target=read_serial,name="ReadSerialDataThread")
    read_thread.daemon = True
    read_thread.start()
    from . import db
    db.init_app(app)

    return app

def read_serial():
    contador = 0
    lat_atual = -19.9167
    lng_atual = -43.9345
    while True:
        contador += 1
        time.sleep(1)

        lat_atual += 0.0005 
        lng_atual += 0.0005
        
        pacote_completo = {
            # Os dados brutos para o seu widget de terminal continuam normais
            "sensores_brutos": {
                "1": 1000 + (contador * 5),
                "2": 99.9 - (contador * 0.1)
            },
            
            # Os aviões agora viajam dentro de uma LISTA []
            "avioes": [
                {"id": "PR-XYZ", "lat": round(lat_atual, 6), "lng": round(lng_atual, 6), "altitude": 10500},
                {"id": "PT-ABC", "lat": round(lat_atual - 0.01, 6), "lng": round(lng_atual, 6), "altitude": 12000}
            ]
        }
        
        socketio.emit('new_data', pacote_completo)

@socketio.on('connect')
def init_connection():
    global thread 
    
    if thread is None:
        print("Iniciando a transmissão de dados do avião...")
        thread = socketio.start_background_task(read_serial)
    else:
        print("Cliente conectado, mas o loop já está rodando.")

if __name__ == '__main__':
    app = create_app()
    socketio.run(app)
