<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  data?: any[]
}>();

// Minimal configuration leveraging the modular ECharts components we registered
const chartOption = computed(() => {
  return {
    tooltip: {
      trigger: 'axis'
    },
    grid: {
      left: '0%',
      right: '0%',
      bottom: '0%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun']
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        name: 'Saldo',
        type: 'line',
        data: [1200, 1350, 1100, 1800, 1750, 2100],
        smooth: true,
        itemStyle: {
          color: '#10b981' // emerald-500
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
