module.exports = {
  handlePickersClose() { this.setData({ collegePickerVisible: false, majorPickerVisible: false, gradePickerVisible: false }) },
  handleCollegeToggle() { if (this.data.collegePickerVisible) this.handleCollegeClose(); else this.handleCollegeOpen() },
  handleMajorToggle() { if (this.data.majorPickerVisible) this.handleMajorClose(); else this.handleMajorOpen() },
  handleGradeToggle() { this.setData({ collegePickerVisible: false, majorPickerVisible: false, gradePickerVisible: !this.data.gradePickerVisible }) },

  handleCollegeOpen() {
    this.setData({ collegePickerVisible: true, majorPickerVisible: false, gradePickerVisible: false, collegeLoading: true, collegeError: '' })
    return this.viewModel.loadColleges(1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ collegeError: error.message }))
      .finally(() => this.setData({ collegeLoading: false }))
  },

  handleCollegeMore() {
    if (this.data.collegeLoading) return
    this.setData({ collegeLoading: true })
    return this.viewModel.loadColleges((this.data.collegePage || 1) + 1).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ collegeError: error.message }))
      .finally(() => this.setData({ collegeLoading: false }))
  },

  handleCollegeClose() { this.setData({ collegePickerVisible: false }) },
  handleCollegePick(e) {
    this.applyViewModelResult(this.viewModel.selectCollege(e.currentTarget.dataset.index))
    this.handleCollegeClose()
  },

  handleGradePick(e) { this.applyViewModelResult(this.viewModel.selectGrade(e.currentTarget.dataset.index)); this.handlePickersClose() },
  handleMajorOpen() { return this.loadMajorPage(1) },
  handleMajorMore() { if (!this.data.majorLoading) return this.loadMajorPage(this.data.majorPage + 1) },
  loadMajorPage(page) {
    this.setData({ majorPickerVisible: true, collegePickerVisible: false, gradePickerVisible: false, majorLoading: true, majorError: '' })
    return this.viewModel.loadMajors(page).then(result => this.applyViewModelResult(result))
      .catch(error => this.setData({ majorError: error.message }))
      .finally(() => this.setData({ majorLoading: false }))
  },
  handleMajorClose() { this.setData({ majorPickerVisible: false }) },
  handleMajorPick(e) {
    this.applyViewModelResult(this.viewModel.selectMajor(e.currentTarget.dataset.index))
    this.handleMajorClose()
  },

}
