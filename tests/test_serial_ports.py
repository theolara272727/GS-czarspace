import json
import tempfile
import threading
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import patch

from flask import Flask
import serial

import flaskr
from flaskr.serial_ports import SerialPorts


class FakeSerial:
    def __init__(self, port, lines=()):
        self.port = port
        self.baudrate = 115200
        self.is_open = True
        self.lines = deque(lines)
        self.writes = []

    def readline(self):
        item = self.lines.popleft() if self.lines else b''
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, data):
        self.writes.append(data)
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.is_open = False


class SerialIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.main = FakeSerial('COM14')
        self.uwb = FakeSerial('COM15')
        self.app = self.make_app()
        self.modes = [{
            'code': '0x31', 'name': 'Distâncias M2',
            'dataTypes': ['Origem', 'D_GS', 'D_Gabriella', 'D_Carolina', 'D_Beatriz'],
        }]
        flaskr._save_modes(self.app, self.modes)
        self.processor = flaskr.uwb.ProcessadorUwb()
        processor_patch = patch.object(flaskr, 'uwb_processor', self.processor)
        processor_patch.start()
        self.addCleanup(processor_patch.stop)

    def make_app(self, **overrides):
        app = Flask('flaskr', instance_path=self.temporary.name)
        config = {
            'TESTING': True,
            'UWB_SOURCE': 'serial',
            'UWB_SERIAL_PORT': 'COM15',
            'SERIAL_PORT': 'COM14',
            'SERIAL_CONNECTION': self.main,
            'UWB_SERIAL_CONNECTION': self.uwb,
            'SERIAL_READER_ENABLED': False,
            'SYNTHETIC_TELEMETRY_ENABLED': False,
        }
        config.update(overrides)
        with patch.object(flaskr, 'Flask', return_value=app), patch.object(flaskr.threading, 'Thread'):
            return flaskr.create_app(config)

    def send(self, payload):
        with self.app.app_context():
            return flaskr.handle_serial_command(payload)

    def test_serial_status_is_independent_and_sent_to_new_clients(self):
        client = flaskr.socketio.test_client(self.app)
        self.addCleanup(client.disconnect)
        initial = [event['args'][0] for event in client.get_received()
                   if event['name'] == 'serial_status']
        self.assertEqual({s['target']: s['connected'] for s in initial}, {
            'main': False, 'uwb': False,
        })
        ports = self.app.extensions['serial_ports']
        ports.open('main')
        ports.open('uwb')
        opened = [event['args'][0] for event in client.get_received()
                  if event['name'] == 'serial_status']
        self.assertEqual({s['target']: s['connected'] for s in opened}, {
            'main': True, 'uwb': True,
        })
        self.main.lines.append(serial.SerialException('cabo desconectado'))
        with self.assertRaises(serial.SerialException):
            ports.readline('main')
        failed = [event['args'][0] for event in client.get_received()
                  if event['name'] == 'serial_status']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['target'], 'main')
        self.assertFalse(failed[0]['connected'])
        self.assertEqual(failed[0]['message'], 'cabo desconectado')
        self.assertTrue(ports.status('uwb')['connected'])
        newcomer = flaskr.socketio.test_client(self.app)
        self.addCleanup(newcomer.disconnect)
        snapshot = [event['args'][0] for event in newcomer.get_received()
                    if event['name'] == 'serial_status']
        self.assertEqual({s['target']: s['connected'] for s in snapshot}, {
            'main': False, 'uwb': True,
        })

    def test_serial_status_recovers_after_open_failure_and_explicit_close(self):
        self.app.config['SERIAL_CONNECTION'] = None
        ports = self.app.extensions['serial_ports']
        with patch('flaskr.serial_ports.serial.Serial', side_effect=serial.SerialException('ocupada')):
            with self.assertRaises(serial.SerialException):
                ports.open('main')
        self.assertFalse(ports.status('main')['connected'])
        self.assertEqual(ports.status('main')['message'], 'ocupada')
        with patch('flaskr.serial_ports.serial.Serial', return_value=self.main):
            ports.open('main')
        self.assertTrue(ports.status('main')['connected'])
        self.assertEqual(ports.status('main')['message'], '')
        ports.close('main')
        self.assertFalse(ports.status('main')['connected'])

    def test_readers_start_independently(self):
        for source in ('serial', 'simulado', 'off'):
            app = Flask('flaskr', instance_path=self.temporary.name)
            with patch.object(flaskr, 'Flask', return_value=app), patch.object(flaskr.threading, 'Thread') as thread:
                flaskr.create_app({
                    'UWB_SOURCE': source,
                    'UWB_SERIAL_PORT': 'COM15',
                    'SERIAL_PORT': 'COM14',
                    'SYNTHETIC_TELEMETRY_ENABLED': False,
                    'SERIAL_READER_ENABLED': True,
                })
                targets = [call.kwargs['target'] for call in thread.call_args_list]
                self.assertIn(flaskr.emit_data, targets)
                self.assertEqual(flaskr.run_uwb_loop in targets, source == 'serial')

    def test_simulation_is_disabled_even_when_requested(self):
        app = self.make_app(UWB_SOURCE='simulado')
        self.assertEqual(app.config['UWB_SOURCE'], 'off')
        with patch.object(flaskr.uwb, 'SimuladorUwb') as simulator, \
                patch.object(flaskr.socketio, 'emit') as emit:
            flaskr.run_uwb_loop(app)
        simulator.assert_not_called()
        emit.assert_not_called()

    def test_default_uwb_source_is_off(self):
        app = Flask('flaskr', instance_path=self.temporary.name)
        with patch.dict('os.environ', {}, clear=True), \
                patch.object(flaskr, 'Flask', return_value=app), \
                patch.object(flaskr.threading, 'Thread'):
            app = flaskr.create_app({'SERIAL_READER_ENABLED': False})
        self.assertEqual(app.config['SERIAL_PORT'], 'COM14')
        self.assertEqual(app.config['UWB_SERIAL_PORT'], 'COM15')
        self.assertEqual(app.config['UWB_SOURCE'], 'off')

    def test_commands_route_only_to_selected_port(self):
        self.assertTrue(self.send({'command': 'STATUS'})['ok'])
        self.assertTrue(self.send({'command': 'P', 'target': 'uwb'})['ok'])
        self.assertEqual(self.main.writes, [b'STATUS\n'])
        self.assertEqual(self.uwb.writes, [b'P\n'])

    def test_both_sends_once_to_each_port(self):
        result = self.send({'command': 'STATUS', 'target': 'both'})
        self.assertTrue(result['ok'])
        self.assertEqual(self.main.writes, [b'STATUS\n'])
        self.assertEqual(self.uwb.writes, [b'STATUS\n'])
        self.assertEqual([item['target'] for item in result['results']], ['main', 'uwb'])
        self.assertIn('Principal:', result['message'])
        self.assertIn('DW1000:', result['message'])

    def test_both_respects_each_ports_newline(self):
        self.app.config['UWB_SERIAL_COMMAND_NEWLINE'] = False
        self.assertTrue(self.send({'command': 'STATUS', 'target': 'both'})['ok'])
        self.assertEqual(self.main.writes, [b'STATUS\n'])
        self.assertEqual(self.uwb.writes, [b'STATUS'])

    def test_both_still_sends_to_dw1000_if_main_fails(self):
        with patch.object(self.main, 'write', side_effect=serial.SerialException('disconnected')):
            result = self.send({'command': 'STATUS', 'target': 'both'})
        self.assertFalse(result['ok'])
        self.assertFalse(result['results'][0]['ok'])
        self.assertTrue(result['results'][1]['ok'])
        self.assertEqual(self.uwb.writes, [b'STATUS\n'])

    def test_both_reports_partial_success_when_dw1000_disabled(self):
        self.app.config['UWB_SOURCE'] = 'off'
        result = self.send({'command': 'STATUS', 'target': 'both'})
        self.assertFalse(result['ok'])
        self.assertTrue(result['results'][0]['ok'])
        self.assertFalse(result['results'][1]['ok'])
        self.assertEqual(self.main.writes, [b'STATUS\n'])
        self.assertFalse(self.uwb.writes)

    def test_socketio_command_ack_uses_selected_port(self):
        client = flaskr.socketio.test_client(self.app)
        self.addCleanup(client.disconnect)
        result = client.emit('serial_command', {'command': 'P', 'target': 'uwb'}, callback=True)
        self.assertTrue(result['ok'])
        self.assertIn('COM15', result['message'])
        self.assertEqual(self.uwb.writes, [b'P\n'])
        self.assertFalse(self.main.writes)

    def test_invalid_target_never_writes(self):
        for target in ('other', '', None, [], {}):
            self.assertFalse(self.send({'command': 'X', 'target': target})['ok'])
        self.assertEqual(self.main.writes, [])
        self.assertEqual(self.uwb.writes, [])

    def test_simulation_does_not_block_main_commands(self):
        self.app.config['UWB_SOURCE'] = 'simulado'
        self.assertTrue(self.send({'command': 'STATUS', 'target': 'main'})['ok'])
        self.assertFalse(self.send({'command': 'P', 'target': 'uwb'})['ok'])
        self.assertEqual(self.uwb.writes, [])

    def test_each_port_has_its_own_newline_configuration(self):
        self.app.config['UWB_SERIAL_COMMAND_NEWLINE'] = False
        self.send({'command': 'P', 'target': 'uwb'})
        self.send({'command': 'STATUS', 'target': 'main'})
        self.assertEqual(self.uwb.writes, [b'P'])
        self.assertEqual(self.main.writes, [b'STATUS\n'])

    def test_main_telemetry_parser_preserved(self):
        flaskr._save_modes(self.app, [{'name': 'IDLE', 'code': '0x1', 'dataTypes': ['T', 'V']}])
        self.main.lines.append(b'1794526281 0x01 NaN 8.7\r\n')
        with patch.object(flaskr.socketio, 'emit') as emit:
            packet = flaskr.read_serial(self.app)
        self.assertEqual(packet['values'], {'T': None, 'V': 8.7})
        self.assertEqual(packet['serialSource']['target'], 'main')
        json.dumps(packet, allow_nan=False)
        self.assertNotIn('serial_received', [call.args[0] for call in emit.call_args_list])
        self.assertEqual(self.uwb.writes, [])

    def test_nontelemetry_main_message_has_origin(self):
        self.main.lines.append(b'ACK\r\n')
        with patch.object(flaskr.socketio, 'emit') as emit:
            self.assertIsNone(flaskr.read_serial(self.app))
        event, packet = emit.call_args.args
        self.assertEqual(event, 'serial_received')
        self.assertEqual(packet['target'], 'main')
        self.assertEqual(packet['port'], 'COM14')

    def test_all_uwb_bytes_go_to_terminal_and_partial_lines_are_kept(self):
        self.uwb.lines.extend([b'D,0,1,3', b'.5,-60,100\r\n', b'ACK\n'])
        buffer = bytearray()
        with patch.object(flaskr.socketio, 'emit') as emit:
            self.assertEqual(flaskr._uwb_read_line(self.app, buffer), [])
            self.assertEqual(flaskr._uwb_read_line(self.app, buffer), ['D,0,1,3.5,-60,100'])
            self.assertEqual(flaskr._uwb_read_line(self.app, buffer), ['ACK'])
        packets = [call for call in emit.call_args_list if call.args[0] != 'serial_status']
        self.assertEqual(len(packets), 2)
        telemetry, text = packets
        self.assertEqual(telemetry.args[0], 'serial_telemetry')
        self.assertEqual(telemetry.args[1]['serialSource']['target'], 'uwb')
        self.assertEqual(telemetry.args[1]['serialSource']['port'], 'COM15')
        self.assertEqual(telemetry.args[1]['values']['Distancia'], 3.5)
        self.assertEqual(text.args[0], 'serial_received')
        self.assertEqual(text.args[1]['target'], 'uwb')
        self.assertEqual(text.args[1]['text'], 'ACK\n')
        self.assertFalse(self.main.writes)

    def test_native_dw1000_telemetry_is_not_duplicated_as_raw_text(self):
        self.uwb.lines.append(b'784 0x31 0 nan nan nan 0.4172446\r\n')
        with patch.object(flaskr.socketio, 'emit') as emit:
            flaskr._uwb_read_line(self.app, bytearray())
        packets = [call for call in emit.call_args_list if call.args[0] != 'serial_status']
        self.assertEqual(len(packets), 1)
        event, payload = emit.call_args.args
        self.assertEqual(event, 'serial_telemetry')
        self.assertEqual(payload['deviceTimestamp'], 784)
        self.assertEqual(payload['values'], {
            'Origem': 0, 'D_GS': None, 'D_Gabriella': None,
            'D_Carolina': None, 'D_Beatriz': 0.4172446,
        })
        json.dumps(payload, allow_nan=False)

    def test_csv_activation_writes_only_to_uwb(self):
        with patch.object(flaskr, '_uwb_read_line', return_value=['CSV bruto: ON']):
            enabled, _ = flaskr._uwb_enable_csv(self.app, bytearray())
        self.assertTrue(enabled)
        self.assertEqual(self.uwb.writes, [b'V\n'])
        self.assertEqual(self.main.writes, [])

    def test_native_dw1000_packets_do_not_trigger_csv_commands(self):
        packet = b'346 0x31 0 nan 1.543139 nan nan\r\n'
        self.uwb.lines.append(packet)
        lines = flaskr._uwb_serial_lines(self.app)
        self.addCleanup(lines.close)
        with patch.object(flaskr.time, 'sleep'), patch.object(flaskr.socketio, 'emit'):
            self.assertEqual(next(lines), packet.decode().strip())
        self.assertEqual(self.uwb.writes, [])

    def test_native_dw1000_packet_publishes_constellation_telemetry(self):
        processor = flaskr.uwb.ProcessadorUwb()
        self.uwb.lines.append(b'346 0x31 0 nan 1.543139 nan nan\n')
        with patch.object(flaskr, 'uwb_processor', processor), \
                patch.object(flaskr, '_uwb_serial_lines', side_effect=lambda app: iter(flaskr._uwb_read_line(app, bytearray()))), \
                patch.object(flaskr.uwb, 'PERIODO_TELEMETRIA_S', 0), \
                patch.object(flaskr.uwb, 'PERIODO_S', 10**10), \
                patch.object(flaskr.socketio, 'emit') as emit:
            flaskr.run_uwb_loop(self.app)
        payload = next(call.args[1] for call in emit.call_args_list if call.args[0] == 'uwb_data')
        self.assertEqual(payload['values']['dA1'], 1.5431)
        self.assertEqual(payload['modeCode'], '0x31')
        self.assertEqual(payload['serialSource']['target'], 'uwb')
        self.assertEqual(processor.medidas_total, 1)

    def test_both_ports_follow_reordered_config_and_uwb_consumes_named_values(self):
        self.assertIs(flaskr.parse_serial_message, flaskr.uwb.parse_serial_message)
        self.modes[0]['dataTypes'] = ['Origem', 'D_GS', 'D_Beatriz', 'D_Carolina', 'D_Gabriella']
        flaskr._save_modes(self.app, self.modes)
        raw = b'346 0x31 0 nan nan nan 1.543139\n'
        self.main.lines.append(raw)
        self.uwb.lines.append(raw)
        main_packet = flaskr.read_serial(self.app)
        with patch.object(flaskr.socketio, 'emit') as emit:
            flaskr._uwb_read_line(self.app, bytearray())
        uwb_packet = emit.call_args.args[1]
        self.assertEqual(main_packet['values'], uwb_packet['values'])
        self.assertEqual(uwb_packet['values']['D_Gabriella'], 1.543139)
        self.assertIsNone(uwb_packet['values']['D_Beatriz'])
        self.assertEqual(self.processor.telemetria()['values'], {'dA1': 1.5431})
        self.assertEqual(self.processor.medidas_total, 1)

    def test_unregistered_uwb_mode_remains_raw_and_does_not_create_modes(self):
        flaskr._save_modes(self.app, [])
        before = Path(self.app.instance_path, 'config.json').read_bytes()
        self.uwb.lines.append(b'346 0x31 0 nan 1.5 nan nan\n')
        with patch.object(flaskr.socketio, 'emit') as emit:
            flaskr._uwb_read_line(self.app, bytearray())
        self.assertEqual(emit.call_args.args[0], 'serial_received')
        self.assertIsNone(self.processor.telemetria())
        self.assertEqual(Path(self.app.instance_path, 'config.json').read_bytes(), before)

    def test_uwb_reinitializes_after_a_command_breaks_connection(self):
        self.app.config['UWB_SERIAL_CONNECTION'] = None
        self.app.config['UWB_AUTO_ENABLE_CSV'] = True
        broken = FakeSerial('COM15')
        replacement = FakeSerial('COM15')
        lines = flaskr._uwb_serial_lines(self.app)
        self.addCleanup(lines.close)
        with patch('flaskr.serial_ports.serial.Serial', side_effect=[broken, replacement]), \
                patch.object(flaskr.time, 'sleep'), \
                patch.object(flaskr.socketio, 'emit'), \
                patch.object(flaskr, '_uwb_enable_csv', return_value=(True, [])) as enable_csv:
            self.assertIsNone(next(lines))
            with patch.object(broken, 'write', side_effect=serial.SerialException('disconnected')):
                self.assertFalse(self.send({'command': 'P', 'target': 'uwb'})['ok'])
            self.assertIsNone(next(lines))
            self.assertIsNone(next(lines))
            self.assertEqual(enable_csv.call_count, 2)
            self.assertTrue(replacement.is_open)
            self.assertTrue(self.main.is_open)

    def test_uwb_event_and_csv_do_not_mix_with_main(self):
        processor = flaskr.uwb.ProcessadorUwb()
        self.uwb.lines.append(b'D,0,1,3.5,-60,100\n')
        with patch.object(flaskr, 'uwb_processor', processor), \
                patch.object(flaskr, '_uwb_serial_lines', side_effect=lambda app: iter(flaskr._uwb_read_line(app, bytearray()))), \
                patch.object(flaskr.uwb, 'PERIODO_TELEMETRIA_S', 0), \
                patch.object(flaskr.uwb, 'PERIODO_S', 10**10), \
                patch.object(flaskr.socketio, 'emit') as emit:
            flaskr.run_uwb_loop(self.app)
        events = [call.args[0] for call in emit.call_args_list]
        self.assertIn('uwb_data', events)
        self.assertNotIn('new_data', events)
        self.assertTrue(Path(self.app.config['UWB_TELEMETRY_CSV']).exists())
        self.assertNotIn('dA2', Path(self.app.config['TELEMETRY_CSV']).read_text())

    def test_command_destinations_persist_and_old_commands_default_to_main(self):
        client = self.app.test_client()
        commands_path = Path(self.temporary.name) / 'commands.json'
        commands_path.write_text(json.dumps({'commands': [{'name': 'iniciar', 'command': 'G 00 {timestamp}'}]}))
        commands = client.get('/commands').json['commands']
        self.assertEqual(commands[0]['target'], 'main')
        commands.append({'name': 'UWB', 'command': 'P', 'target': 'uwb'})
        self.assertEqual(client.post('/commands', json={'commands': commands}).status_code, 200)
        self.assertEqual(client.get('/commands').json['commands'][1]['target'], 'uwb')
        self.assertEqual(json.loads(commands_path.read_text())['commands'][1]['target'], 'uwb')
        commands[0]['target'] = 'both'
        self.assertEqual(client.post('/commands', json={'commands': commands}).status_code, 200)
        self.assertEqual(client.get('/commands').json['commands'][0]['target'], 'both')
        commands[0]['target'] = 'invalid'
        self.assertEqual(client.post('/commands', json={'commands': commands}).status_code, 400)


class ConnectionIsolationTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            'SERIAL_PORT': 'COM14', 'SERIAL_BAUD': 115200,
            'UWB_SERIAL_PORT': 'COM15', 'UWB_SERIAL_BAUD': 115200,
            'UWB_SOURCE': 'serial',
        }

    def test_same_port_is_rejected(self):
        self.config['UWB_SERIAL_PORT'] = 'COM14'
        with self.assertRaises(ValueError):
            SerialPorts(self.config)

    def test_connections_and_reconnection_are_independent(self):
        main = FakeSerial('COM14', [b'ACK\n', b'OK\n'])
        broken = FakeSerial('COM15', [serial.SerialException('disconnected')])
        replacement = FakeSerial('COM15', [b'UWB\n'])
        ports = SerialPorts(self.config)
        with patch('flaskr.serial_ports.serial.Serial', side_effect=[main, broken, replacement]):
            self.assertEqual(ports.readline('main')[0], b'ACK\n')
            with self.assertRaises(serial.SerialException):
                ports.readline('uwb')
            self.assertTrue(main.is_open)
            self.assertFalse(broken.is_open)
            self.assertEqual(ports.readline('uwb')[0], b'UWB\n')
            self.assertEqual(ports.readline('main')[0], b'OK\n')

    def test_short_write_closes_only_its_connection(self):
        main = FakeSerial('COM14')
        uwb = FakeSerial('COM15')
        ports = SerialPorts(self.config)
        with patch('flaskr.serial_ports.serial.Serial', side_effect=[main, uwb]):
            ports.open('main')
            ports.open('uwb')
            with patch.object(main, 'write', return_value=1):
                with self.assertRaises(serial.SerialTimeoutException):
                    ports.write('main', b'STATUS\n')
            self.assertFalse(main.is_open)
            self.assertTrue(uwb.is_open)
            ports.write('uwb', b'P\n')
        self.assertEqual(uwb.writes, [b'P\n'])

    def test_blocked_main_does_not_block_uwb(self):
        self.config['UWB_SERIAL_CONNECTION'] = FakeSerial('COM15')
        ports = SerialPorts(self.config)
        completed = threading.Event()
        errors = []

        def send():
            try:
                ports.write('uwb', b'P\n')
                completed.set()
            except Exception as error:
                errors.append(error)

        with ports.locks['main']:
            worker = threading.Thread(target=send)
            worker.start()
            independent = completed.wait(1)
        worker.join(timeout=2)
        self.assertFalse(errors)
        self.assertTrue(independent)


if __name__ == '__main__':
    unittest.main()
