import { ref } from 'vue'

const globalRefreshTrigger = ref(0)

export const useRefresh = () => {
  const triggerRefresh = () => {
    globalRefreshTrigger.value++
  }

  return {
    globalRefreshTrigger,
    triggerRefresh
  }
}
