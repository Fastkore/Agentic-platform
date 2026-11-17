#!/opt/bridge-office/bin/python -I
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack, contextmanager

from openpyxl import load_workbook


TIMEOUT = 120
SLOTS = Path('/opt/bridge-office/slots')
FILTERS = {'docx': 'Office Open XML Text', 'xlsx': 'Calc MS Excel 2007 XML'}
PDF_INPUTS = {'.doc', '.docx', '.xls', '.xlsx'}


@contextmanager
def conversion_slot(deadline):
    with ExitStack() as stack:
        locks = [stack.enter_context(slot.open('rb')) for slot in (SLOTS / '1', SLOTS / '2')]
        while time.monotonic() < deadline:
            for lock in locks:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                yield
                return
            time.sleep(0.1)
    raise TimeoutError('Нет свободного места для конвертации за 120 секунд.')


def run(command, env, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Конвертация заняла более 120 секунд.')
    with subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, start_new_session=True) as process:
        try:
            log, _ = process.communicate(timeout=remaining)
        except BaseException as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if isinstance(error, subprocess.TimeoutExpired):
                raise TimeoutError('Конвертация заняла более 120 секунд.') from error
            raise
    if process.returncode:
        raise ValueError(log.decode('utf-8', errors='replace')[-2000:].strip() or 'Команда завершилась с ошибкой.')


def convert(source, format_name, temporary, env, deadline):
    profile = temporary / 'profile'
    user = profile / 'user'
    user.mkdir(parents=True)
    (user / 'registrymodifications.xcu').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '</item><item oor:path="/org.openoffice.Office.Calc/Formula/Load">'
        '<prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop>'
        '</item></oor:items>', encoding='utf-8')
    filter_name = FILTERS.get(format_name)
    output_format = f'{format_name}:{filter_name}' if filter_name else format_name
    result = temporary / source.with_suffix('.' + format_name).name
    with conversion_slot(deadline):
        run(['/usr/bin/libreoffice', f'-env:UserInstallation={profile.as_uri()}', '--headless',
             '--norestore', '--nodefault', '--convert-to', output_format, '--outdir', str(temporary), str(source)],
            env, deadline)
    if not result.is_file() or result.stat().st_size == 0:
        raise ValueError('LibreOffice не создал файл. Проверьте формат и защиту исходного документа.')
    return result


def formula_report(file):
    with ExitStack() as stack:
        formulas = load_workbook(file, read_only=True, keep_links=False)
        stack.callback(formulas.close)
        values = load_workbook(file, read_only=True, data_only=True, keep_links=False)
        stack.callback(values.close)
        count = 0
        errors = []
        for sheet in formulas.worksheets:
            for formula_row, value_row in zip(sheet.rows, values[sheet.title].rows, strict=True):
                for formula, value in zip(formula_row, value_row, strict=True):
                    if formula.data_type == 'f':
                        count += 1
                        if value.data_type == 'e':
                            errors.append({'sheet': sheet.title, 'cell': formula.coordinate, 'error': value.value})
        return {'formulaCount': count, 'errorCount': len(errors), 'errors': errors}


def job_path(job, value):
    target = (job / value).resolve()
    if not target.is_relative_to(job):
        raise ValueError('Путь должен быть внутри рабочей папки задания.')
    return target


def main():
    parser = argparse.ArgumentParser(prog='fk-office', description='Конвертация и проверка документов текущего задания.')
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('to-pdf', 'recalc', 'convert', 'pages'):
        item = commands.add_parser(command)
        item.add_argument('file')
        if command == 'convert':
            item.add_argument('format', choices=('docx', 'xlsx', 'pdf'))
        if command != 'recalc':
            item.add_argument('--outdir')
    args = parser.parse_args()
    job = Path.cwd()
    source = job_path(job, args.file)
    if not source.is_file():
        raise ValueError('Исходный файл не найден.')
    extension = source.suffix.lower()
    allowed = PDF_INPUTS if args.command == 'to-pdf' else {'.xlsx'}
    if args.command == 'pages':
        allowed = {'.pdf'}
    if args.command == 'convert':
        allowed = {'docx': {'.doc'}, 'xlsx': {'.xls'}, 'pdf': PDF_INPUTS}[args.format]
    if extension not in allowed:
        raise ValueError('Формат исходного файла не поддерживается этой командой.')

    deadline = time.monotonic() + TIMEOUT
    with tempfile.TemporaryDirectory(prefix='.office-', dir=job) as directory:
        temporary = Path(directory)
        env = {**os.environ, 'HOME': directory, 'TMPDIR': directory, 'TMP': directory, 'TEMP': directory,
               'XDG_CACHE_HOME': directory, 'XDG_CONFIG_HOME': directory, 'XDG_DATA_HOME': directory}
        if args.command == 'pages':
            dest = job_path(job, args.outdir or source.stem + '-pages')
            pages = temporary / 'pages'
            pages.mkdir()
            run(['/usr/bin/pdftoppm', '-scale-to', '1600', '-png', str(source), str(pages / 'page')], env, deadline)
            if not any(pages.iterdir()):
                raise ValueError('PDF не содержит доступных страниц.')
            dest.parent.mkdir(parents=True, exist_ok=True)
            pages.rename(dest)
            print(json.dumps([str(page.relative_to(job)) for page in sorted(dest.iterdir())], ensure_ascii=False))
            return 0

        format_name = {'to-pdf': 'pdf', 'recalc': 'xlsx'}.get(args.command) or args.format
        result = convert(source, format_name, temporary, env, deadline)
        if args.command == 'recalc':
            report = formula_report(result)
            result.replace(source)
            print(json.dumps(report, ensure_ascii=False))
            return int(report['errorCount'] > 0)
        dest = job_path(job, args.outdir or '.') / result.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        result.replace(dest)
        print(dest.relative_to(job))
        return 0


def terminate(_signum, _frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyboardInterrupt) as error:
        print(f'fk-office: {error}', file=sys.stderr)
        sys.exit(1)
