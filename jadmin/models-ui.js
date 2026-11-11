// Model controls are intentionally independent from slow monitoring requests.
const modelNotice = document.createElement('p');
modelNotice.id = 'modelNotice';
modelNotice.setAttribute('role', 'status');
modelNotice.setAttribute('aria-live', 'polite');
$('loadmodels').after(modelNotice);
let modelBusy = false;
async function refreshModels() {
  if (modelBusy) return;
  modelBusy = true;
  const button = $('loadmodels');
  button.disabled = true;
  button.textContent = '正在拉取…';
  modelNotice.textContent = '正在读取已保存的接口配置并拉取模型…';
  modelNotice.className = 'muted';
  try {
    const result = await api('/api/model-status');
    const previous = $('model').value;
    const ids = [...new Set(result.models || [])];
    const current = result.defaultModel;
    if (current && !ids.includes(current)) ids.unshift(current);
    $('model').replaceChildren();
    if (!ids.length) $('model').add(new Option('暂无模型，请重新拉取', ''));
    for (const id of ids) {
      const label = id === current ? id + '（当前默认）' : id;
      $('model').add(new Option(label, id));
    }
    $('model').value = ids.includes(previous) ? previous : (current || ids[0] || '');
    $('savebtn').disabled = !ids.length;
    modelNotice.textContent = result.error || ('已拉取 ' + result.models.length + ' 个模型；当前默认：' + (current || '未设置'));
    modelNotice.className = result.error ? 'bad' : 'ok';
  } catch (error) {
    modelNotice.textContent = '拉取失败：' + error.message + '。请稍后重试。';
    modelNotice.className = 'bad';
  } finally {
    button.disabled = false;
    button.textContent = '重新拉取模型';
    modelBusy = false;
  }
}
$('loadmodels').onclick = refreshModels;
const originalLoad = load;
load = async function () {
  await Promise.allSettled([originalLoad(), refreshModels()]);
};
const originalSave = $('savebtn').onclick;
$('savebtn').onclick = async function () {
  $('savebtn').disabled = true;
  try {
    await originalSave();
    await refreshModels();
  } catch (error) {
    modelNotice.textContent = '保存失败：' + error.message;
    modelNotice.className = 'bad';
  } finally { $('savebtn').disabled = false; }
};
