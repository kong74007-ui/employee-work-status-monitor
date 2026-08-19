const els = {
  statusText: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  scheduleRule: document.querySelector("#scheduleRule"),
  nextUpload: document.querySelector("#nextUpload"),
  activeWindow: document.querySelector("#activeWindow"),
  employeeName: document.querySelector("#employeeName"),
  department: document.querySelector("#department"),
  serverUrl: document.querySelector("#serverUrl"),
  lastUpload: document.querySelector("#lastUpload"),
  runningNote: document.querySelector("#runningNote"),
  profileEditor: document.querySelector("#profileEditor"),
  profileEmployeeId: document.querySelector("#profileEmployeeId"),
  profileEmployeeName: document.querySelector("#profileEmployeeName"),
  profileDepartment: document.querySelector("#profileDepartment"),
  profileError: document.querySelector("#profileError"),
  editProfileBtn: document.querySelector("#editProfileBtn"),
  cancelProfileBtn: document.querySelector("#cancelProfileBtn"),
  saveProfileBtn: document.querySelector("#saveProfileBtn"),
  uploadNowBtn: document.querySelector("#uploadNowBtn"),
  startBtn: document.querySelector("#startBtn"),
  hideBtn: document.querySelector("#hideBtn"),
};

const statusColors = {
  "运行中": "#52c479",
  "等待时段": "#e6b450",
  "正在上传": "#e6b450",
  "上传失败": "#f25c5c",
  "已停止": "#b4bccb",
  "准备中": "#b4bccb",
};

let currentState = null;

window.employeeClient.onState((state) => {
  currentState = state;
  els.statusText.textContent = state.statusText;
  els.statusDot.style.background = statusColors[state.statusText] || "#b4bccb";
  els.statusDot.style.color = statusColors[state.statusText] || "#b4bccb";
  els.scheduleRule.textContent = `${state.activeStartTime} - ${state.activeEndTime} · 每 ${state.intervalMinutes} 分钟一次`;
  els.nextUpload.textContent = state.nextUploadText;
  els.activeWindow.textContent = `工作时段 ${state.activeStartTime} - ${state.activeEndTime}`;
  els.employeeName.textContent = `${state.employeeName} / ${state.employeeId}`;
  els.department.textContent = state.department;
  els.serverUrl.textContent = state.serverUrl;
  els.lastUpload.textContent = state.lastUploadText;
  els.runningNote.textContent = state.running ? "已自动开启，可隐藏到托盘" : "已暂停自动上报";
  els.startBtn.disabled = state.running;
});

function openProfileEditor() {
  if (!currentState) return;
  els.profileEmployeeId.value = currentState.employeeId || "";
  els.profileEmployeeName.value = currentState.employeeName || "";
  els.profileDepartment.value = currentState.department || "";
  els.profileError.textContent = "";
  els.profileEditor.hidden = false;
}

function closeProfileEditor() {
  els.profileEditor.hidden = true;
  els.profileError.textContent = "";
}

function saveProfile() {
  const employeeId = els.profileEmployeeId.value.trim();
  const employeeName = els.profileEmployeeName.value.trim();
  const department = els.profileDepartment.value.trim();
  if (!employeeId || !employeeName) {
    els.profileError.textContent = "员工ID和姓名不能为空";
    return;
  }
  window.employeeClient.updateProfile({ employeeId, employeeName, department });
  closeProfileEditor();
}

els.editProfileBtn.addEventListener("click", openProfileEditor);
els.cancelProfileBtn.addEventListener("click", closeProfileEditor);
els.saveProfileBtn.addEventListener("click", saveProfile);
els.startBtn.addEventListener("click", () => window.employeeClient.start());
els.uploadNowBtn.addEventListener("click", () => window.employeeClient.uploadNow());
els.hideBtn.addEventListener("click", () => window.employeeClient.hide());
