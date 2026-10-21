import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


class UpstreamPublisherGuards(unittest.TestCase):
    def test_upstream_npm_publishers_are_disabled_in_divine(self):
        for name in ("publish-types.yaml", "publish-db-migrator.yaml"):
            with self.subTest(workflow=name):
                text = (ROOT / ".github/workflows" / name).read_text()
                match = re.search(r"(?ms)^  publish:\n(.*?)(?=^  [a-zA-Z_]|\Z)", text)
                self.assertIsNotNone(match)
                condition = re.search(r"(?m)^    if: (.+)$", match.group(1))
                self.assertIsNotNone(condition)
                self.assertEqual(condition.group(1), "${{ github.repository == 'roostorg/coop' }}")

    def test_upstream_docker_publisher_is_not_imported(self):
        self.assertFalse((ROOT / ".github/workflows/publish-docker.yaml").exists())

    def test_divine_source_release_keeps_dispatch_and_exact_source_authorization(self):
        text = (ROOT / ".github/workflows/publish-concord-source.yaml").read_text()
        publish = re.search(r"(?ms)^  publish:\n(.*?)(?=^  [a-zA-Z_]|\Z)", text).group(1)
        condition = re.search(r"(?m)^    if: (.+)$", publish).group(1)
        self.assertEqual(condition, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.publish == true && inputs.publication_authorization == inputs.source_sha")
        self.assertIn('git -C tooling merge-base --is-ancestor "$SOURCE_SHA" origin/main', text)
        self.assertIn('git -C tooling merge-base --is-ancestor "$HARNESS_SHA" origin/main', text)
        self.assertRegex(text, r"(?ms)^      publish:.*?^        default: false$")

    def test_divine_client_release_keeps_divine_tag_namespace(self):
        text = (ROOT / ".github/workflows/build-and-push.yaml").read_text()
        self.assertRegex(text, r"(?ms)^    tags:\n      - ['\"]divine-v\*['\"]")
        self.assertIn("ORG: divinevideo", text)
        self.assertIn("context: ./divine/coop-client-unprivileged", text)



if __name__ == "__main__":
    unittest.main()
