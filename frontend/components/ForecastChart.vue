<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  data?: any[]
}>();

// Minimal configuration leveraging the modular ECharts components we registered
const chartOption = computed(() => {
  const dates = props.data?.map(t => {
    if(!t.date) return ''
    const [_, month, day] = String(t.date).split('-')
    return `${day}/${month}`
  }) || ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun']
  
  const balances = props.data?.map(t => t.balance || 0) || [0, 0, 0, 0, 0, 0]

  return {
    tooltip: {
      trigger: 'axis'
    },
    grid: {
      left: '1%',
      right: '1%',
      bottom: '0%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: dates
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        name: 'Saldo Projetado',
        type: 'line',
        data: balances,
        smooth: true,
        itemStyle: {
          color: '#10b981' // emerald-500
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(16, 185, 129, 0.4)' },
              { offset: 1, color: 'rgba(16, 185, 129, 0.0)' }
            ]
          }
        },
        markLine: {
          data: [
            { type: 'average', name: 'Média' }
          ]
        }
      }
    ]
  };
});
</script>

<template>
  <div class="w-full h-72">
    <!-- VChart is globally registered by our plugin -->
    <VChart class="w-full h-full" :option="chartOption" autoresize />
  </div>
</template>
