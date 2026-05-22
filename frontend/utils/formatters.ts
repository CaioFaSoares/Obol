export const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('pt-BR', { 
    style: 'currency', 
    currency: 'BRL' 
  }).format(value);
};

export const getForecastRange = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - (offset * 60 * 1000));
  const startDate = localDate.toISOString().split('T')[0];
  
  const future = new Date(localDate.getTime());
  future.setDate(future.getDate() + 30);
  const endDate = future.toISOString().split('T')[0];

  return { startDate, endDate };
};
