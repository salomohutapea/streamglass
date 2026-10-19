import os
import tempfile
import unittest
from unittest.mock import patch
from backend.service import Service


class DevelopmentSettingsTests(unittest.TestCase):
    def test_development_default_does_not_override_saved_settings(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'STREAMGLASS_PROXY_PORT': '18080'}):
            service = Service(directory, 'fixture-token', 47821)
            self.assertEqual(service.settings['proxyPort'], 18080)
            service.settings['proxyPort'] = 18081
            service.persist_config()
            service.db.close()
            with patch.dict(os.environ, {'STREAMGLASS_PROXY_PORT': '18082'}):
                service = Service(directory, 'fixture-token', 47821)
                self.assertEqual(service.settings['proxyPort'], 18081)
                service.db.close()

    def test_invalid_development_ports_are_rejected(self):
        for value in ('invalid', '0', '65536', '47821'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'STREAMGLASS_PROXY_PORT': value}):
                with self.assertRaisesRegex(ValueError, 'STREAMGLASS_PROXY_PORT'):
                    Service(directory, 'fixture-token', 47821)
