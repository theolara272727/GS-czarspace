import json
import unittest

from flaskr import uwb


class UwbProtocolTests(unittest.TestCase):
    def setUp(self):
        self.modes = [{
            'code': '0x31', 'name': 'Distâncias M2',
            'dataTypes': ['Origem', 'D_GS', 'D_Gabriella', 'D_Carolina', 'D_Beatriz'],
        }]

    def process(self, processor, line, **kwargs):
        return processor.processa_linha(line, modes=self.modes, **kwargs)

    def test_parser_exposes_named_fields_without_changing_state(self):
        packet = uwb.parse_serial_line('784 0x31 0 nan nan nan 0.4172446\r\n', self.modes)
        self.assertEqual(packet['deviceTimestamp'], 784)
        self.assertEqual(packet['values']['D_Beatriz'], 0.4172446)
        self.assertIsNone(packet['values']['D_GS'])
        self.assertEqual(packet['measurements'], [(0, 1, 0.4172446)])
        json.dumps(packet, allow_nan=False)

    def test_received_packet_with_nan(self):
        processor = uwb.ProcessadorUwb()
        packet = '346 0x31 0 nan 1.543139 nan nan\r\n'
        self.assertEqual(self.process(processor, packet, t=1234), packet.strip())
        telemetry = processor.telemetria()
        self.assertEqual(telemetry['modeCode'], '0x31')
        self.assertEqual(telemetry['values'], {'dA1': 1.5431})
        self.assertEqual(processor.pares.ultimo[(0, 2)], 1234)
        self.assertEqual(processor.medidas_total, 1)
        json.dumps(telemetry, allow_nan=False)

    def test_distances_follow_gs_gabriella_carolina_beatriz_order(self):
        samples = [
            ('10 0x31 1 1 2 3 nan', {'dA2': 1, 'd12': 2, 'd23': 3}),
            ('11 0x31 2 4 nan 5 6', {'dA1': 4, 'd13': 5, 'd12': 6}),
            ('12 0x31 3 7 8 nan 9', {'dA3': 7, 'd13': 8, 'd23': 9}),
        ]
        for packet, expected in samples:
            with self.subTest(packet=packet):
                processor = uwb.ProcessadorUwb()
                self.assertIsNotNone(self.process(processor, packet))
                values = processor.telemetria()['values']
                for key, value in expected.items():
                    self.assertEqual(values[key], value)
                self.assertEqual(processor.medidas_total, 3)

    def test_all_nan_is_recognized_without_fabricating_distances(self):
        processor = uwb.ProcessadorUwb()
        packet = '346 0x31 0 nan NaN NAN nan'
        self.assertEqual(self.process(processor, packet), packet)
        self.assertIsNone(processor.telemetria())
        self.assertEqual(processor.medidas_total, 0)

    def test_invalid_distances_do_not_erase_last_valid_measurement(self):
        processor = uwb.ProcessadorUwb()
        self.process(processor, '1 0x31 0 nan 1.5 nan nan', t=10)
        self.process(processor, '2 0x31 0 nan nan inf -1', t=20)
        self.assertEqual(processor.telemetria()['values'], {'dA1': 1.5})
        self.assertEqual(processor.pares.ultimo[(0, 2)], 10)

    def test_unknown_modes_and_malformed_packets_are_not_telemetry(self):
        packets = [
            'ACK', '346 0x30 0 nan 1.5 nan nan',
            'nan 0x31 0 nan 1.5 nan nan',
            '346 0x31 0 nan 1.5 nan',
            '346 0x31 0 nan 1.5 nan nan extra',
            '346 0x31 0 nan texto nan nan',
        ]
        for packet in packets:
            with self.subTest(packet=packet):
                processor = uwb.ProcessadorUwb()
                self.assertIsNone(self.process(processor, packet))
                self.assertIsNone(processor.telemetria())

    def test_self_distance_is_not_added(self):
        processor = uwb.ProcessadorUwb()
        self.process(processor, '1 0x31 0 100 1.5 nan nan')
        self.assertNotIn((0, 0), processor.pares.amostras)

    def test_legacy_csv_remains_supported(self):
        processor = uwb.ProcessadorUwb()
        self.assertEqual(processor.processa_linha('D,0,2,1.543139,-60,346'), 'D,0,2,1.543139,-60,346')
        self.assertEqual(processor.telemetria()['values']['dA1'], 1.5431)

    def test_reordered_config_controls_field_names_and_constellation_pairs(self):
        self.modes[0]['dataTypes'] = ['D_Beatriz', 'D_GS', 'Origem', 'D_Carolina', 'D_Gabriella']
        packet = uwb.parse_serial_line('346 0x31 2 1 0 3 4', self.modes)
        self.assertEqual(packet['values'], {
            'D_Beatriz': 2, 'D_GS': 1, 'Origem': 0, 'D_Carolina': 3, 'D_Gabriella': 4,
        })
        processor = uwb.ProcessadorUwb()
        processor.processa_telemetria(packet)
        self.assertEqual(processor.telemetria()['values'], {'dA1': 4, 'dA2': 2, 'dA3': 3})

    def test_no_implicit_native_schema_without_configured_mode(self):
        self.assertIsNone(uwb.parse_serial_line('346 0x31 0 nan 1.5 nan nan', []))
        self.assertIsNone(uwb.parse_serial_line('346 0x31 0 nan 1.5 nan nan'))

    def test_config_can_add_fields_without_fixed_packet_length(self):
        self.modes[0]['dataTypes'] = ['Aux', 'D_Beatriz', 'Origem', 'D_GS', 'D_Carolina', 'D_Gabriella']
        packet = uwb.parse_serial_line('346 0x31 99 2 0 1 3 4', self.modes)
        self.assertEqual(packet['values']['Aux'], 99)
        processor = uwb.ProcessadorUwb()
        processor.processa_telemetria(packet)
        self.assertEqual(processor.telemetria()['values'], {'dA1': 4, 'dA2': 2, 'dA3': 3})

    def test_renamed_fields_do_not_fall_back_to_positional_uwb_mapping(self):
        self.modes[0]['dataTypes'] = ['Campo1', 'Campo2', 'Campo3', 'Campo4', 'Campo5']
        packet = uwb.parse_serial_line('346 0x31 0 1 2 3 4', self.modes)
        self.assertEqual(packet['values']['Campo3'], 2)
        self.assertEqual(packet['measurements'], [])

    def test_other_registered_modes_are_telemetry_without_uwb_measurements(self):
        packet = uwb.parse_serial_line('346 0x10 25', [{
            'code': '0x10', 'name': 'Outro modo', 'dataTypes': ['Temperatura'],
        }])
        self.assertEqual(packet['values'], {'Temperatura': 25})
        self.assertEqual(packet['measurements'], [])

    def test_json_uses_same_configured_order(self):
        message = json.dumps({'timestamp': 346, 'modeCode': '0x31', 'values': [0, None, 1.5, 2, 3]})
        # O parser comum mantém a validação de valores numéricos.
        self.assertIsNone(uwb.parse_serial_line(message, self.modes))
        message = json.dumps({'timestamp': 346, 'modeCode': '0x31', 'values': [0, 0, 1.5, 2, 3]})
        packet = uwb.parse_serial_line(message, self.modes)
        self.assertEqual(packet['values']['D_Gabriella'], 1.5)

    def test_unknown_origin_is_telemetry_but_not_a_valid_distance_pair(self):
        for origin in ('4', '0.5', 'nan'):
            packet = uwb.parse_serial_line(f'346 0x31 {origin} nan 1.5 nan nan', self.modes)
            self.assertIsNotNone(packet)
            self.assertEqual(packet['measurements'], [])


if __name__ == '__main__':
    unittest.main()
