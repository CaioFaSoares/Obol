import { ref } from 'vue'

const isOpen = ref(false)
const editingTransaction = ref<any>(null)

export const useTransactionEdit = () => {
  const open = (transaction: any) => {
    editingTransaction.value = JSON.parse(JSON.stringify(transaction))
    isOpen.value = true
  }
  
  const close = () => {
    isOpen.value = false
    editingTransaction.value = null
  }

  return {
    isOpen,
    editingTransaction,
    open,
    close
  }
}
