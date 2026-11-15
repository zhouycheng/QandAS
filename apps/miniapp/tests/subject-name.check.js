const assert = require('assert')
const { splitSubjectName } = require('../miniprogram/models/bank-detail-presentation.js')
assert.deepStrictEqual(splitSubjectName('数据库原理与应用（MySQL版）'), { title: '数据库原理与应用', version: '（MySQL版）' })
assert.deepStrictEqual(splitSubjectName('数据库 (MySQL版)'), { title: '数据库', version: '(MySQL版)' })
for (const name of ['高等数学', '课程（基础）练习', '（MySQL版）', '课程（未闭合']) {
  assert.deepStrictEqual(splitSubjectName(name), { title: name, version: '' })
}
console.log('科目名称：正文、末尾括号说明与完整名称保留检查通过')
