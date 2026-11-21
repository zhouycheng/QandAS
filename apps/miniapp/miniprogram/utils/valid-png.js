function validPng(data) {
  const bytes = new Uint8Array(data)
  return bytes.length >= 20 && bytes.length <= 5 * 1024 * 1024 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) &&
    [73, 69, 78, 68, 174, 66, 96, 130].every((value, i) => bytes[bytes.length - 8 + i] === value)
}

module.exports = { validPng }
