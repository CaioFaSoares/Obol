export const useRecurrenceModal = () => {
  const isOpen = useState('recurrenceModalOpen', () => false);
  
  const open = () => isOpen.value = true;
  const close = () => isOpen.value = false;

  return { isOpen, open, close };
}
