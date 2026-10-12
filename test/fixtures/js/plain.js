export function format(value) {
  const rounded = Math.round(value);
  return `$${rounded}`;
}

export function run(value) {
  const text = format(value);
  if (text) {
    return text;
  }
  return '';
}
