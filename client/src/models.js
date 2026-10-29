'use strict';
function normalizeModels(data) {
 return (data || []).filter(m => typeof (m.model || m.id) === 'string').map(m => ({
  id: m.model || m.id, name: m.displayName || m.model || m.id, isDefault: !!m.isDefault,
  defaultEffort: m.defaultReasoningEffort || '',
  efforts: (m.supportedReasoningEfforts || []).filter(e => typeof e.reasoningEffort === 'string').map(e => ({id: e.reasoningEffort, description: e.description || ''}))
 }));
}
function chooseModel(selected, models) {
 if (selected) {
  if (models.length && !models.some(m => m.id === selected)) throw new Error('所选模型不在当前可用列表中，请重新选择。');
  return selected;
 }
 return models.find(m => m.isDefault)?.id || models[0]?.id || null;
}
function modelInfo(selected, models) {return models.find(m => m.id === chooseModel(selected, models));}
function chooseEffort(selected, model) {
 if (selected) {
  if (!model?.efforts?.some(e => e.id === selected)) throw new Error('当前模型不支持所选推理强度，请重新选择。');
  return selected;
 }
 return model?.efforts?.some(e => e.id === model.defaultEffort) ? model.defaultEffort : null;
}
module.exports = {normalizeModels, chooseModel, modelInfo, chooseEffort};
