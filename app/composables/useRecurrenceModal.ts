import { ref } from 'vue'

export const useRecurrenceModal = () => {
  const isOpen = useState('recurrenceModalOpen', () => false);
  const recurrenceToEdit = useState<any | null>('recurrenceToEdit', () => null);
  
  const open = (rec: any = null) => {
    recurrenceToEdit.value = rec;
    isOpen.value = true;
  };
  const close = () => {
    isOpen.value = false;
    recurrenceToEdit.value = null;
  };

  return { isOpen, recurrenceToEdit, open, close };
}
