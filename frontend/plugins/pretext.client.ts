import pretext from 'pretext';

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('pretext', {
    mounted(el) {
      pretext(el);
    },
    updated(el) {
      pretext(el);
    }
  });
});
