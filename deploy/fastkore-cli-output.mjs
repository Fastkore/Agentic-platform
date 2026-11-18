import { spawn } from 'node:child_process';

const stderrLimitBytes = 512 * 1024;

function capture(stream, limitBytes) {
  let bytes = 0;
  const chunks = [];
  stream.on('data', chunk => {
    if (bytes + chunk.length <= limitBytes) chunks.push(chunk);
    bytes += chunk.length;
  });
  return () => ({ bytes, text: bytes <= limitBytes ? Buffer.concat(chunks, bytes).toString('utf8') : undefined });
}

export function runCliProcess(executable, args, options, ticket, stdoutLimitBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    const stdout = capture(child.stdout, stdoutLimitBytes), stderr = capture(child.stderr, stderrLimitBytes);
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', exitCode => {
      if (failure) reject(failure);
      else resolve({ exitCode, stdout: stdout(), stderr: stderr() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(ticket ? ticket + '\n' : undefined, 'ascii');
  });
}
