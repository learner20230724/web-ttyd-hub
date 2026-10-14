<script setup>
defineProps({ status: { type: Object, required: true }, compact: Boolean })
</script>
<template>
  <span class="activity-badge" :class="status.state" :title="status.detail" role="status" :aria-label="status.label">
    <span class="activity-dot" aria-hidden="true">{{ status.state === 'waiting' ? '?' : status.state === 'error' ? '!' : status.state === 'unread' ? '✓' : '' }}</span>
    <span v-if="!compact">{{ status.label }}</span>
  </span>
</template>
<style scoped>
.activity-badge { display:inline-flex; align-items:center; gap:7px; min-width:0; color:#a8b6ca; font-size:12px; line-height:1.5; font-weight:500; }
.activity-dot { width:14px; height:14px; flex:0 0 14px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:currentColor; color:inherit; font-size:10px; }
.activity-dot:empty { width:8px; height:8px; flex-basis:8px; margin:0 3px; }
.busy { color:#7dd3fc; }.busy .activity-dot { width:14px; height:14px; flex-basis:14px; margin:0; background:transparent; border:2px solid #38546b; border-top-color:currentColor; animation:activity-spin 1s linear infinite; }
.unread { color:#6ee7b7; }.unread .activity-dot { background:#6ee7b7; color:#073728; }
.waiting { color:#fcd34d; }.waiting .activity-dot { background:#fcd34d; color:#432c00; }
.error { color:#fda4af; }.error .activity-dot { background:#fda4af; color:#4c1024; }
.interrupted { color:#c4b5fd; }.unknown { color:#a8b6ca; }
@keyframes activity-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .busy .activity-dot { animation:none; } }
</style>
