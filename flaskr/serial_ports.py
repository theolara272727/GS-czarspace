"""Conexões independentes para a telemetria principal e para o receptor UWB."""
import os
import threading

import serial


SERIAL_TARGETS = ('main', 'uwb')


def validate_target(target, allow_both=False):
    targets = SERIAL_TARGETS + (('both',) if allow_both else ())
    if not isinstance(target, str) or target not in targets:
        raise ValueError('Destino serial inválido.')
    return target


class SerialPorts:
    def __init__(self, config, on_status_change=None):
        self.config = config
        self.on_status_change = on_status_change
        self.connections = {target: None for target in SERIAL_TARGETS}
        self.revisions = {target: 0 for target in SERIAL_TARGETS}
        self.locks = {target: threading.Lock() for target in SERIAL_TARGETS}
        main_port = config.get('SERIAL_PORT')
        uwb_port = config.get('UWB_SERIAL_PORT')
        if main_port and uwb_port:
            if os.path.realpath(main_port).casefold() == os.path.realpath(uwb_port).casefold():
                raise ValueError('Principal e DW1000 devem usar portas seriais diferentes.')
        main_connection = config.get('SERIAL_CONNECTION')
        if main_connection is not None and main_connection is config.get('UWB_SERIAL_CONNECTION'):
            raise ValueError('Principal e DW1000 não podem compartilhar a mesma conexão.')
        self.statuses = {
            target: {**self._info(target, None), 'connected': False, 'message': ''}
            for target in SERIAL_TARGETS
        }

    def _set_status(self, target, connection=None, message=''):
        status = {
            **self._info(target, connection),
            'connected': connection is not None and connection.is_open,
            'message': message,
        }
        if status == self.statuses[target]:
            return
        self.statuses[target] = status
        if self.on_status_change is not None:
            self.on_status_change(dict(status))

    def status(self, target):
        validate_target(target)
        return dict(self.statuses[target])

    def _prefix(self, target):
        validate_target(target)
        return 'SERIAL_' if target == 'main' else 'UWB_SERIAL_'

    def _connection(self, target):
        prefix = self._prefix(target)
        if target == 'uwb' and self.config['UWB_SOURCE'] != 'serial':
            raise serial.SerialException('A porta DW1000 está desligada ou em simulação.')
        configured = self.config.get(prefix + 'CONNECTION')
        if configured is not None:
            return configured
        port = self.config.get(prefix + 'PORT')
        if not port:
            raise serial.SerialException(f'Porta não configurada para {target}.')
        connection = self.connections[target]
        if connection is None or not connection.is_open:
            connection = serial.Serial(
                port=port,
                baudrate=self.config[prefix + 'BAUD'],
                timeout=self.config.get(prefix + 'READ_TIMEOUT', 0.1),
                write_timeout=1,
            )
            self.connections[target] = connection
            self.revisions[target] += 1
        return connection

    def _info(self, target, connection):
        prefix = self._prefix(target)
        return {
            'target': target,
            'port': getattr(connection, 'port', self.config.get(prefix + 'PORT')),
            'baud': getattr(connection, 'baudrate', self.config[prefix + 'BAUD']),
        }

    def _close(self, target, message=''):
        connection = self.connections[target]
        self.connections[target] = None
        if connection is not None:
            self.revisions[target] += 1
            try:
                connection.close()
            except (serial.SerialException, OSError):
                pass
        self._set_status(target, message=message)

    def close(self, target):
        validate_target(target)
        with self.locks[target]:
            self._close(target)

    def open(self, target):
        validate_target(target)
        with self.locks[target]:
            try:
                connection = self._connection(target)
                self._set_status(target, connection)
                return self._info(target, connection)
            except (serial.SerialException, OSError) as error:
                self._close(target, str(error))
                raise

    def revision(self, target):
        validate_target(target)
        with self.locks[target]:
            return self.revisions[target]

    def readline(self, target):
        validate_target(target)
        with self.locks[target]:
            try:
                connection = self._connection(target)
                line = connection.readline()
                self._set_status(target, connection)
                return line, self._info(target, connection)
            except (serial.SerialException, OSError) as error:
                self._close(target, str(error))
                raise

    def write(self, target, data):
        validate_target(target)
        with self.locks[target]:
            try:
                connection = self._connection(target)
                count = connection.write(data)
                if count != len(data):
                    raise serial.SerialTimeoutException(
                        f'Envio incompleto: {count} de {len(data)} bytes.'
                    )
                connection.flush()
                self._set_status(target, connection)
                return count, self._info(target, connection)
            except (serial.SerialException, OSError) as error:
                self._close(target, str(error))
                raise
