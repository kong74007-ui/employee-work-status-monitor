param(
  [int]$Port = 8787,
  [string]$Token = "change-me-token",
  [string]$GlmApiKey = "",
  [string]$GlmVisionModel = "glm-5v-turbo",
  [string]$GlmApiUrl = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
)

$env:MONITOR_PORT = [string]$Port
$env:MONITOR_TOKEN = $Token
if (![string]::IsNullOrWhiteSpace($GlmApiKey)) {
  $env:GLM_API_KEY = $GlmApiKey
}
if (![string]::IsNullOrWhiteSpace($GlmVisionModel)) {
  $env:GLM_VISION_MODEL = $GlmVisionModel
}
if (![string]::IsNullOrWhiteSpace($GlmApiUrl)) {
  $env:GLM_API_URL = $GlmApiUrl
}
node .\server.js
