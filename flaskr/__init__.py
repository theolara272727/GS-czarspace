from flask import (Flask,render_template)
import serial 
import threading
import os
import time
import random
from flask_socketio import SocketIO, send, emit


PORTA = 'COM3' #Porta de entrada de dados
BAUD = 9600 

porta_serial = serial.Serial(PORTA, BAUD) #Configura a porta serial
porta_serial.timeout = 2
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
    while True:
        contador += 1
        time.sleep(2)
        
        dados = {
            "1": 1000 + (contador * 5),
            "2": 99.9 - (contador * 0.1),
            "Temperatura": round(random.uniform(20, 30), 2),
            "Umidade": round(random.uniform(40, 80), 2),
            "Pressão": round(random.uniform(1000, 1025), 2),
            "Luminosidade": round(random.uniform(100, 900), 2)
        }
        # serial_input = porta_serial.readline()
        socketio.emit('new_data', dados)

@socketio.on('connect')
def init_connection():
    socketio.start_background_task(read_serial)

if __name__ == '__main__':
    app = create_app()
    socketio.run(app)
