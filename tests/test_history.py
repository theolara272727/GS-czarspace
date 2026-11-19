import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

import flaskr


class HistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        app = Flask('flaskr', instance_path=temporary.name)
        with patch.object(flaskr, 'Flask', return_value=app):
            self.app = flaskr.create_app({
                'TESTING': True,
                'UWB_SOURCE': 'off',
                'SERIAL_READER_ENABLED': False,
                'SYNTHETIC_TELEMETRY_ENABLED': False,
            })
        context = self.app.app_context()
        context.push()
        self.addCleanup(context.pop)

    def save(self, target, timestamp, mode, values):
        key = 'UWB_TELEMETRY_CSV' if target == 'uwb' else 'TELEMETRY_CSV'
        flaskr.save_telemetry({
            'timestamp': timestamp,
            'receivedTimestamp': timestamp,
            'modeCode': mode,
            'values': values,
        }, csv_path=self.app.config[key])

    def history(self, mode=None):
        return flaskr.query_timeframe(
            '2026-11-18T12:00:00Z', '2026-11-18T12:01:00Z', mode,
        )

    def test_uwb_availability_and_replay_with_source_disabled(self):
        self.save('uwb', '2026-11-18T12:00:02Z', '0x31', {'dA1': 3, 'd12': 2})
        self.save('main', '2026-11-18T12:00:01Z', '0x10', {'V_bateria': 8})
        availability = self.app.test_client().get(
            '/telemetry-availability?modeCode=0x31',
        ).get_json()
        self.assertEqual(availability['start'], '2026-11-18T12:00:02Z')
        self.assertEqual(availability['end'], '2026-11-18T12:00:02Z')
        self.assertEqual(availability['days'], [{'date': '2026-11-18', 'count': 1}])
        result = self.history('0x31')
        self.assertEqual(result['count'], 1)
        sample = result['samples'][0]
        self.assertEqual(sample['dA1'], 3)
        self.assertEqual(sample['d12'], 2)
        self.assertEqual(sample['serialSource'], {'target': 'uwb'})
        self.assertNotIn('V_bateria', sample)

    def test_combines_files_in_chronological_order_and_filters_interval(self):
        self.save('main', '2026-11-18T12:00:03Z', '0x10', {'V_bateria': 8})
        self.save('uwb', '2026-11-18T12:00:02Z', '0x31', {'dA1': 3})
        self.save('uwb', '2026-11-18T12:00:01Z', '0x31', {'dA1': 2})
        self.save('uwb', '2026-11-18T12:02:00Z', '0x31', {'dA1': 9})
        result = self.history()
        self.assertEqual(result['count'], 3)
        self.assertEqual([s['timestamp'] for s in result['samples']], [
            '2026-11-18T12:00:01Z', '2026-11-18T12:00:02Z', '2026-11-18T12:00:03Z',
        ])
        availability = flaskr.query_telemetry_availability()
        self.assertEqual(availability['days'], [{'date': '2026-11-18', 'count': 4}])

    def test_same_timestamp_and_mode_do_not_merge_channels(self):
        for target, value in [('main', 2), ('uwb', 3)]:
            self.save(target, '2026-11-18T12:00:01Z', '0x31', {'dA1': value})
        samples = self.history('0x31')['samples']
        self.assertEqual(len(samples), 2)
        self.assertEqual({s['serialSource']['target']: s['dA1'] for s in samples}, {
            'main': 2, 'uwb': 3,
        })

    def test_missing_uwb_file_preserves_main_history(self):
        self.assertFalse(Path(self.app.config['UWB_TELEMETRY_CSV']).exists())
        self.save('main', '2026-11-18T12:00:01Z', '0x10', {'V_bateria': 8})
        self.assertEqual(self.history('0x10')['samples'][0]['V_bateria'], 8)
        self.assertEqual(self.history('0x31')['count'], 0)
        self.assertEqual(flaskr.query_telemetry_availability('0x31')['days'], [])

    def test_uwb_read_errors_are_not_reported_as_empty_history(self):
        Path(self.app.config['UWB_TELEMETRY_CSV']).mkdir()
        with self.assertRaises(OSError):
            self.history('0x31')
        response = self.app.test_client().get('/telemetry-availability?modeCode=0x31')
        self.assertEqual(response.status_code, 500)


if __name__ == '__main__':
    unittest.main()
