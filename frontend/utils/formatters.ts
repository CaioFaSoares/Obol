export const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('pt-BR', { 
    style: 'currency', 
    currency: 'BRL' 
  }).format(value);
};

export const getForecastRange = (daysOffset: number = 30, pastDays: number = 7) => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - (offset * 60 * 1000));
  
  const past = new Date(localDate.getTime());
  past.setDate(past.getDate() - pastDays);
  const startDate = past.toISOString().split('T')[0];
  
  const future = new Date(localDate.getTime());
  future.setDate(future.getDate() + daysOffset);
  const endDate = future.toISOString().split('T')[0];

  return { startDate, endDate };
};

export const getStatusProps = (status: 'OPEN' | 'CLOSED' | 'PAID') => {
  switch (status) {
    case 'OPEN':
      return { label: 'Aberta', color: 'emerald' as const };
    case 'CLOSED':
      return { label: 'Fechada', color: 'orange' as const };
    case 'PAID':
      return { label: 'Paga', color: 'gray' as const };
    default:
      return { label: 'Desconhecido', color: 'gray' as const };
  }
};
