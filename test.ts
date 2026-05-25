const formatDate = (dateString: string) => {
  if (!dateString) return '';
  const date = new Date(dateString);
  const userTimezoneOffset = date.getTimezoneOffset() * 60000;
  const localDate = new Date(date.getTime() + userTimezoneOffset);
  return new Intl.DateTimeFormat('pt-BR').format(localDate);
};

const formatPeriod = (period: string) => {
  const [year, month] = period.split('-')
  const date = new Date(parseInt(year), parseInt(month) - 1, 1)
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date)
}

console.log(formatDate("2026-05-25 00:00:00.000Z"));
console.log(formatPeriod("2026-05-25"));
