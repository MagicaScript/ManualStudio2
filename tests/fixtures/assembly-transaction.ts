import { zipSync, strToU8 } from 'fflate';

export function transactionModel(names = ['Shell', 'Support', 'Unassigned', 'Extra']): Uint8Array {
  const objects = names.map((name, index) => `<object id="${index + 1}" name="${name}" p:UUID="${name}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object>`).join('');
  return zipSync({ '3D/3dmodel.model': strToU8(`<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>${objects}</resources><build>${names.map((_, index) => `<item objectid="${index + 1}" transform="1 0 0 0 1 0 0 0 1 ${index * 25} 0 0"/>`).join('')}</build></model>`) });
}
