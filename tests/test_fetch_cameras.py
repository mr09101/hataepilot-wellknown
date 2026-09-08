import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_cameras.py"
SPEC = importlib.util.spec_from_file_location("fetch_cameras", SCRIPT)
fetch_cameras = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(fetch_cameras)


def encoded(value) -> bytes:
    return json.dumps(value).encode("utf-8")


def valid_row() -> dict:
    return {column: None for column in fetch_cameras.KEEP}


class CameraCollectionValidationTest(unittest.TestCase):
    def test_total_schema_and_reasonable_range_are_required(self):
        invalid = [
            [],
            {},
            {"totalCount": True},
            {"totalCount": "not-a-number"},
            {"totalCount": 999},
            {"totalCount": 1_000_001},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), mock.patch.object(
                fetch_cameras, "http_get", return_value=encoded(payload)
            ):
                with self.assertRaises(fetch_cameras.PortalDataError):
                    fetch_cameras.fetch_total()

    def test_a_normal_decrease_is_allowed_when_every_page_is_complete(self):
        page_sizes = iter([10_000, 10_000, 4_001])

        def fake_get(_url):
            return encoded([valid_row() for _ in range(next(page_sizes))])

        with mock.patch.object(fetch_cameras, "http_get", side_effect=fake_get):
            rows = fetch_cameras.fetch_rows(24_001)
        self.assertEqual(len(rows), 24_001)

    def test_partial_download_is_rejected_when_later_pages_are_empty(self):
        page_sizes = iter([10_000, 0])

        def fake_get(_url):
            return encoded([valid_row() for _ in range(next(page_sizes))])

        with mock.patch.object(fetch_cameras, "http_get", side_effect=fake_get):
            with self.assertRaises(fetch_cameras.PortalDataError):
                fetch_cameras.fetch_rows(25_000)

    def test_each_page_must_be_a_list_of_objects(self):
        for payload in [{"rows": []}, ["not-an-object"] * 1_000, [{}] * 1_000]:
            with self.subTest(payload=payload), mock.patch.object(
                fetch_cameras, "http_get", return_value=encoded(payload)
            ):
                with self.assertRaises(fetch_cameras.PortalDataError):
                    fetch_cameras.fetch_rows(1_000)

    def test_invalid_partial_collection_does_not_replace_existing_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            database = output / "cameras.db"
            manifest = output / "cameras.json"
            database.write_bytes(b"existing-database")
            manifest.write_text("existing-manifest", encoding="utf-8")
            page_sizes = iter([10_000, 0])

            def fake_get(_url):
                return encoded([valid_row() for _ in range(next(page_sizes))])

            with (
                mock.patch.object(fetch_cameras, "OUT_DIR", output),
                mock.patch.object(fetch_cameras, "fetch_total", return_value=25_000),
                mock.patch.object(fetch_cameras, "http_get", side_effect=fake_get),
            ):
                with self.assertRaises(fetch_cameras.PortalDataError):
                    fetch_cameras.main()

            self.assertEqual(database.read_bytes(), b"existing-database")
            self.assertEqual(manifest.read_text(encoding="utf-8"), "existing-manifest")

    def test_complete_but_nearly_empty_normalized_data_preserves_outputs(self):
        for usable_count in (0, 1):
            with self.subTest(usable_count=usable_count), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                database, manifest = output / "cameras.db", output / "cameras.json"
                database.write_bytes(b"existing-database")
                manifest.write_text("existing-manifest", encoding="utf-8")
                rows = [valid_row() for _ in range(1_000)]
                for row in rows[:usable_count]:
                    row.update(LATITUDE="37.5", LONGITUDE="127.0")
                with (
                    mock.patch.object(fetch_cameras, "OUT_DIR", output),
                    mock.patch.object(fetch_cameras, "fetch_total", return_value=1_000),
                    mock.patch.object(fetch_cameras, "http_get", return_value=encoded(rows)),
                ):
                    with self.assertRaises(fetch_cameras.PortalDataError):
                        fetch_cameras.main()
                self.assertEqual(database.read_bytes(), b"existing-database")
                self.assertEqual(manifest.read_text(encoding="utf-8"), "existing-manifest")


if __name__ == "__main__":
    unittest.main()
