export default defineAppConfig({
  ui: {
    primary: 'emerald',
    gray: 'zinc',
    
    button: {
      default: {
        size: 'md',
        color: 'primary',
        variant: 'solid'
      },
      rounded: 'rounded-md' 
    },
    
    modal: {
      overlay: {
        background: 'bg-zinc-950/75 backdrop-blur-sm'
      },
      rounded: 'rounded-xl'
    },

    card: {
      background: 'bg-zinc-900',
      ring: 'ring-1 ring-zinc-800'
    }
  }
})
