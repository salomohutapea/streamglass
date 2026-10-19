import base64
import csv
import hashlib
import io
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

from scripts import prepare_mitmproxy as recipe
from scripts import audit_python


class DependencyPatchTests(unittest.TestCase):
    def upstream(self, metadata=None):
        output = io.BytesIO()
        old = f"mitmproxy-{recipe.UPSTREAM_VERSION}.dist-info/"
        with zipfile.ZipFile(output, "w") as wheel:
            wheel.writestr("mitmproxy/example.py", b"# upstream code stays identical\n")
            wheel.writestr(old + "licenses/LICENSE", b"MIT License synthetic fixture")
            wheel.writestr(old + "METADATA", metadata or ("\n".join(recipe.REPLACEMENTS) + "\n"))
            wheel.writestr(old + "RECORD", "old-record")
        return output.getvalue()

    def test_patch_preserves_code_and_license_and_rehashes_every_file(self):
        source = self.upstream()
        with patch.object(recipe, "SHA256", hashlib.sha256(source).hexdigest()):
            output = recipe.rebuild(source)
            self.assertEqual(output, recipe.rebuild(source))
        prefix = f"mitmproxy-{recipe.VERSION}.dist-info/"
        with zipfile.ZipFile(io.BytesIO(output)) as wheel:
            self.assertEqual(wheel.read("mitmproxy/example.py"), b"# upstream code stays identical\n")
            self.assertEqual(wheel.read(prefix + "licenses/LICENSE"), b"MIT License synthetic fixture")
            metadata = wheel.read(prefix + "METADATA").decode()
            for line in recipe.REPLACEMENTS.values():
                self.assertIn(line + "\n", metadata)
            for name, digest, size in csv.reader(io.StringIO(wheel.read(prefix + "RECORD").decode())):
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, size), ("", ""))
                    continue
                raw = wheel.read(name)
                self.assertEqual(int(size), len(raw))
                self.assertEqual(digest, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).rstrip(b"=").decode())

    def test_changed_upstream_bytes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "checksum"):
            recipe.rebuild(self.upstream())

    def test_changed_metadata_is_rejected_even_with_valid_input_hash(self):
        source = self.upstream("Version: unexpected\n")
        with patch.object(recipe, "SHA256", hashlib.sha256(source).hexdigest()):
            with self.assertRaisesRegex(ValueError, "metadata"):
                recipe.rebuild(source)

    def test_audit_queries_upstream_version_for_local_compatibility_build(self):
        calls = []
        def fetch(path, payload=None):
            calls.append((path, payload))
            return {"results": [{}]}
        distribution = SimpleNamespace(metadata={"Name": "mitmproxy"}, version=recipe.VERSION)
        with patch.object(audit_python.importlib.metadata, "distributions", return_value=[distribution]), \
             patch.object(audit_python, "fetch", side_effect=fetch), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(audit_python.main(), 0)
        self.assertEqual(calls[0][1]["queries"][0]["version"], recipe.UPSTREAM_VERSION)
        self.assertIn('"auditedUpstream": "12.2.3"', output.getvalue())
