const crypto = require('node:crypto')
function encrypted(storage) {
  const key = crypto.randomBytes(32)
  storage.setEncrypted = async (id, value) => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    storage.set(id, { encrypted: true, iv: iv.toString('base64'), body: body.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
  }
  storage.getEncrypted = async id => {
    const value = storage.get(id)
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.body, 'base64')), cipher.final()]).toString())
  }
  return storage
}
module.exports = { encrypted }
