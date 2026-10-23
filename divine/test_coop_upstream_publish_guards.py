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


    def test_checklist_has_no_pr_checkout_in_write_job_and_fails_closed(self):
        text = (ROOT / ".github/workflows/checklist.yaml").read_text()
        generator = re.search(r"(?ms)^  checklist_inputs:\n(.*?)(?=^  checklist_job:)", text).group(1)
        publisher = re.search(r"(?ms)^  checklist_job:\n(.*)\Z", text).group(1)
        self.assertIn("contents: read", generator)
        self.assertNotIn("pull-requests: write", generator)
        self.assertNotIn("GITHUB_TOKEN:", generator)
        self.assertIn("persist-credentials: false", generator)
        self.assertIn("fetch-depth: 0", generator)
        self.assertIn("needs: checklist_inputs", publisher)
        self.assertIn("if: always()", publisher)
        self.assertNotIn("actions/checkout@", publisher)
        self.assertIn("pull-requests: write", publisher)
        self.assertIn("GENERATION_RESULT !== 'success'", publisher)
        script = publisher.split("        run: |", 1)[1]
        self.assertNotIn("${{", script)
        self.assertNotIn(".github/scripts/", script)
        self.assertIn("JSON.parse(env.CHECKLIST_DATA)", script)

    def test_tooling_actions_are_pinned_and_checkouts_do_not_persist_tokens(self):
        for name in ("apply_pr_checks.yaml", "build-and-push.yaml", "checklist.yaml", "mdbook.yml", "publish-db-migrator.yaml", "publish-types.yaml", "semantic_pr.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            for action in re.findall(r"(?m)^\s*(?:- )?uses: ([^ \n]+)", text):
                with self.subTest(workflow=name, action=action):
                    if not action.startswith("./"):
                        self.assertRegex(action, r"@[0-9a-f]{40}$")
            for checkout in re.finditer(r"(?m)^\s*(?:- )?uses: actions/checkout@[^\n]+\n", text):
                with self.subTest(workflow=name, checkout=checkout.start()):
                    lines = text[checkout.end():].splitlines()
                    self.assertEqual(lines[0].strip(), "with:")
                    indent = len(lines[0]) - len(lines[0].lstrip())
                    options = []
                    for line in lines[1:]:
                        if line.strip() and len(line) - len(line.lstrip()) <= indent:
                            break
                        options.append(line.strip())
                    self.assertIn("persist-credentials: false", options)

    def test_pages_write_permissions_are_limited_to_deployment(self):
        text = (ROOT / ".github/workflows/mdbook.yml").read_text()
        before_jobs = text.split("jobs:", 1)[0]
        build = re.search(r"(?ms)^  build:\n(.*?)(?=^  deploy:)", text).group(1)
        deploy = re.search(r"(?ms)^  deploy:\n(.*)\Z", text).group(1)
        for permission in ("pages: write", "id-token: write"):
            self.assertNotIn(permission, before_jobs)
            self.assertNotIn(permission, build)
            self.assertIn(permission, deploy)



if __name__ == "__main__":
    unittest.main()
