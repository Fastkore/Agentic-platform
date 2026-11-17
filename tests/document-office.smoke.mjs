// Run with the worker image's Node, from stdin, in an isolated test container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { runJobOffice } from '/app/dist/server/job-office.js';

const root = '/runner/jobs';
await mkdir(`${root}/other`);
await writeFile(`${root}/other/private.txt`, 'other job');
await writeFile('/run/bridge-codex/private.txt', 'worker only');
await writeFile('/home/node/.codex/private.txt', 'credentials volume only');
const loopback = createServer(socket => socket.end('outside the sandbox'));
loopback.listen(0, '127.0.0.1');
await once(loopback, 'listening');

const generate = String.raw`
from pathlib import Path
import socket
import subprocess
import sys
from docx import Document
from openpyxl import Workbook
import lxml, PIL, matplotlib.pyplot, pypdf, reportlab, pdfplumber, pdf2image

for filename in ['../other/private.txt', '/run/bridge-codex/private.txt', '/home/node/.codex/private.txt']:
    try:
        Path(filename).read_bytes()
    except (FileNotFoundError, PermissionError):
        pass
    else:
        raise AssertionError('Read outside the job: ' + filename)
try:
    with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=1):
        raise AssertionError('Sandbox has loopback access')
except OSError:
    pass
assert subprocess.run(['python', '-m', 'pip', '--version'], capture_output=True).returncode != 0

Path('input').mkdir()
Path('output').mkdir()
sample = Document()
sample.add_paragraph('Reference', style='Heading 1')
sample.save('input/sample.docx')
document = Document('input/sample.docx')
document.paragraphs[0].text = '\u041a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u043e\u0435'
document.save('output/quote.docx')
workbook = Workbook()
workbook.active.title = 'Cost'
workbook.active['A1'] = '=20*3'
workbook.save('output/cost.xlsx')
workbook.active['A2'] = '=1/0'
workbook.save('errors.xlsx')
`;

const verify = String.raw`
from pathlib import Path
from subprocess import check_output
from docx import Document
from openpyxl import load_workbook
from PIL import Image

title = '\u041a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u043e\u0435'
assert Document('output/quote.docx').paragraphs[0].text == title
assert load_workbook('output/cost.xlsx').active['A1'].value.startswith('=')
assert load_workbook('output/cost.xlsx', data_only=True).active['A1'].value == 60
assert title in check_output(['pdftotext', 'output/quote.pdf', '-']).decode()
assert '60' in check_output(['pdftotext', 'cost.pdf', '-']).decode()
assert 'Carlito' in check_output(['fc-match', 'Calibri']).decode()
assert 'Liberation Sans' in check_output(['fc-match', 'Arial']).decode()
page, = Path('quote-pages').glob('*.png')
Image.open(page).verify()
assert not list(Path('.').glob('.office-*'))
`;

const timeoutTest = String.raw`
import os, runpy, time
from pathlib import Path

office = runpy.run_path('/usr/local/bin/fk-office')
try:
    office['run'](['/bin/sh', '-c', 'sleep 60 & echo $! > child.pid; wait'], os.environ, time.monotonic() + 1)
except TimeoutError:
    pass
else:
    raise AssertionError('Expected a timeout')
child = Path('child.pid').read_text().strip()
stat = Path('/proc') / child / 'stat'
assert not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] == 'Z'
`;

async function office(job, program, args, expected = true) {
  const result = await runJobOffice(job, { program, args }, AbortSignal.timeout(150_000));
  assert.equal(result.success, expected, `${program} ${args[0]}: ${result.text}`);
  return result.text;
}

async function checkJob(index) {
  const workDirectoryId = randomUUID();
  const workspace = `${root}/${workDirectoryId}`;
  const job = { cliPath: '/usr/local/bin/codex', workDirectoryId, workspace, allowWrite: true };
  await mkdir(workspace);
  await writeFile(`${workspace}/generate.py`, generate);
  await writeFile(`${workspace}/verify.py`, verify);
  await office(job, 'python', ['generate.py', String(loopback.address().port)]);
  await office(job, 'fk-office', ['to-pdf', 'output/quote.docx', '--outdir', 'output']);
  assert.deepEqual(JSON.parse(await office(job, 'fk-office', ['recalc', 'output/cost.xlsx'])), {
    formulaCount: 1, errorCount: 0, errors: [],
  });
  await office(job, 'fk-office', ['to-pdf', 'output/cost.xlsx']);
  await office(job, 'fk-office', ['pages', 'output/quote.pdf']);
  await office(job, 'python', ['verify.py']);
  if (index === 0) {
    const errors = JSON.parse(await office(job, 'fk-office', ['recalc', 'errors.xlsx'], false));
    assert.deepEqual(errors, { formulaCount: 2, errorCount: 1, errors: [{ sheet: 'Cost', cell: 'A2', error: '#DIV/0!' }] });
    await writeFile(`${workspace}/timeout.py`, timeoutTest);
    await office(job, 'python', ['timeout.py']);
  }
}

try {
  await Promise.all(Array.from({ length: 4 }, (_, index) => checkJob(index)));
  for (const stat of ['memory.peak', 'pids.peak']) {
    const value = await readFile(`/sys/fs/cgroup/${stat}`, 'utf8').catch(() => undefined);
    if (value) console.log(`${stat}=${value.trim()}`);
  }
  console.log('Office smoke test passed for 4 simultaneous jobs.');
} finally {
  loopback.close();
}
