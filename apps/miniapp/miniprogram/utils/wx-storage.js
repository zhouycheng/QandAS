/**
 * 微信本地存储适配器。
 * 注入给 ViewModel / Repository，避免业务层直接依赖全局 wx。
 */
function createWxStorageAdapter(options) {
  const normalizedOptions = options || {}
  const storage = normalizedOptions.storage || (typeof wx !== 'undefined' ? wx : null)

  if (!storage) {
    return {
      get() {
        return null
      },

      set() {},

      remove() {},

      keys() {
        return []
      }
    }
  }

  function encryptionAvailable() {
    try {
      const info = storage.getAppBaseInfo ? storage.getAppBaseInfo() : storage.getSystemInfoSync ? storage.getSystemInfoSync() : null
      const parts = String(info && info.SDKVersion || '').split('.').map(Number), minimum = [2, 21, 3]
      for (let i = 0; i < minimum.length; i++) {
        if (!Number.isInteger(parts[i])) return false
        if (parts[i] !== minimum[i]) return parts[i] > minimum[i]
      }
      return true
    } catch (_) { return false }
  }

  return {
    get(key) {
      return storage.getStorageSync(key)
    },

    getEncrypted(key) {
      if (!storage.getStorage || !encryptionAvailable()) return Promise.reject(new Error('请更新微信后继续练习'))
      return new Promise((resolve, reject) => storage.getStorage({ key, encrypt: true, success: result => resolve(result.data), fail: reject }))
    },

    setEncrypted(key, data) {
      if (!storage.setStorage || !encryptionAvailable()) return Promise.reject(new Error('请更新微信后继续练习'))
      return new Promise((resolve, reject) => storage.setStorage({ key, data, encrypt: true, success: resolve, fail: reject }))
    },

    info() { return storage.getStorageInfoSync() },

    set(key, value) {
      storage.setStorageSync(key, value)
    },

    remove(key) {
      storage.removeStorageSync(key)
    },

    keys() {
      try {
        return storage.getStorageInfoSync().keys || []
      } catch (error) {
        return []
      }
    },
    keysStrict() {
      return storage.getStorageInfoSync().keys || []
    }
  }
}

module.exports = {
  createWxStorageAdapter
}
