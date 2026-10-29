'use strict';
function normalizeModels(data){return (data||[]).filter(m=>typeof (m.model||m.id)==='string').map(m=>({id:m.model||m.id,name:m.displayName||m.model||m.id,isDefault:!!m.isDefault}));}
function chooseModel(selected,models){if(selected){if(models.length&&!models.some(m=>m.id===selected))throw new Error('所选模型不在当前可用列表中，请重新选择。');return selected;}return models.find(m=>m.isDefault)?.id||models[0]?.id||null;}
module.exports={normalizeModels,chooseModel};
