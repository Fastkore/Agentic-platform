export function shortUserName(name: string | undefined): string {
  const [surname = '', ...names] = (name ?? '').trim().split(/\s+/u);
  const initials = names.map(part => /^([\p{L}]\.)+$/u.test(part)
    ? part
    : part.split('-').filter(Boolean).map(piece => Array.from(piece)[0].toLocaleUpperCase('ru-RU') + '.').join('-'));
  return [surname, ...initials].join(' ');
}

export function userInitials(name: string): string {
  return name.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toLocaleUpperCase('ru-RU');
}
