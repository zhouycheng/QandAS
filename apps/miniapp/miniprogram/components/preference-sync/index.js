const preferences = require('../../repositories/preference-repository.js')
const { createWxStorageAdapter } = require('../../utils/wx-storage.js')
Component({
  data: { preferenceSyncMessage: '', preferenceConflict: false, preferenceCanRetry: false },
  lifetimes: {
    attached() { this.storage = createWxStorageAdapter(); this.watch() },
    detached() { if (this.unwatch) this.unwatch(); this.unwatch = null }
  },
  pageLifetimes: {
    show() { this.watch(); preferences.refreshPreferences(this.storage) },
    hide() { if (this.unwatch) this.unwatch(); this.unwatch = null }
  },
  methods: {
    watch() {
      if (!this.storage || this.unwatch) return
      this.unwatch = preferences.observe(this.storage, data => { this.setData(data); this.triggerEvent('updated') })
    },
    useCloud() { preferences.resolveConflict(this.storage, false) },
    useLocal() { preferences.resolveConflict(this.storage, true) },
    retry() { preferences.refreshPreferences(this.storage) }
  }
})
