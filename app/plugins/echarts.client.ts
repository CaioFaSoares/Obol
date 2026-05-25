import { use } from 'echarts/core';

import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import { 
  GridComponent, 
  TooltipComponent, 
  MarkLineComponent 
} from 'echarts/components';

import VChart from 'vue-echarts';

export default defineNuxtPlugin((nuxtApp) => {
  use([
    CanvasRenderer,
    LineChart,
    GridComponent,
    TooltipComponent,
    MarkLineComponent
  ]);

  nuxtApp.vueApp.component('VChart', VChart);
});
