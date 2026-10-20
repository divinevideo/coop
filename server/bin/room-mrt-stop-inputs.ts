import { readFileSync } from 'node:fs';

import { recordedRoomStopInputs } from '../routes/concord/recordedRoomExecutionInputs.js';
import { jsonStringify, tryJsonParse } from '../utils/encoding.js';

// Reads only explicitly supplied GraphQL JSON on stdin; never contacts a service.
try {
  const response: unknown = tryJsonParse(readFileSync(0, 'utf8'));
  process.stdout.write(`${jsonStringify(recordedRoomStopInputs(response))}\n`);
} catch {
  // Do not echo input or JSON-parser errors, which can contain submitted text.
  process.stderr.write(
    'Invalid recorded-decision response. Use the minimal query in divine/README.md.\n',
  );
  process.exitCode = 1;
}
