from flask import (Flask,render_template)
import serial 
import threading
import os

PORTA = 'COM1' #Porta de entrada de dados
BAUD = 9600 

porta_serial = serial.Serial(PORTA, BAUD) #Configura a porta serial
porta_serial.timeout = 2

def read_serial():
     global serial_input
     while True:
         serial_input = porta_serial.readline()



def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
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


# if __name__ == '__main__':
#     read_thread = threading.Thread(target=read_serial,name="ReadSerialDataThread")
#     read_thread.daemon = True
#     read_thread.start()
#     app.run(use_reloader=False)
