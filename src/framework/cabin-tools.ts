import type { ToolDef } from 'cortico/core/types.ts';

const text = { type:'string' };
const number = (minimum: number, maximum: number) => ({ type:'integer', minimum, maximum });
const choice = (...values: string[]) => ({ type:'string', enum:values });
type Declaration = Pick<ToolDef,'name'|'description'|'parameters'|'tags'>;

function tool(name: string, description: string, properties: Record<string, unknown> = {},
  required: string[] = [], action = false): Declaration {
  return { name:'cabin_' + name, description, parameters:{ type:'object', properties, required, additionalProperties:false },
    tags:action ? ['act'] : ['read'] };
}

export const CABIN_TOOLS = [
  tool('status', 'Read the current Cabin World resident’s location, activity, needs, money and inventory.'),
  tool('look', 'List the current room, its exits and available furniture actions.'),
  tool('catalog', 'Search Cabin World furniture and actions across rooms. Use returned IDs in cabin_use.',
    {query:text,space:text,object:text,offset:number(0,100000),limit:number(1,50)}),
  tool('task', 'Read a Cabin World task receipt. Running means work continues. Done confirms completion.', {taskId:text}, ['taskId']),
  tool('go', 'Walk to a place in Cabin World, such as xjhome, park, shop, onsen, arcade or restaurant.',
    {place:text,zone:text}, ['place'], true),
  tool('use', 'Use furniture, write in a diary, or play an arcade game. Search the catalog for action IDs. Check the task receipt for the result.',
    {object:text,use:text,item:text,feeling:text,text,mode:choice('npc','solo','duo','join'),durationSeconds:number(0,3600)},
    ['object','use'], true),
  tool('buy', 'Buy a product in Cabin World using the resident’s game money.', {product:text,feeling:text}, ['product'], true),
  tool('eat', 'Consume a product in the resident’s Cabin World inventory.', {product:text,feeling:text}, ['product'], true),
  tool('stop', 'Stop the resident’s current Cabin activity, or finish a timed leisure activity early.',
    {action:choice('stop','finish'),reason:text}, [], true),
  tool('residents', 'List Cabin World residents and their stable IDs.'),
  tool('invite', 'Invite a resident to visit. Use the guest’s stable resident ID.', {guest:text}, ['guest'], true),
  tool('restaurant', 'Use the restaurant menu, order, cook, eat, sit, check status, or cancel.',
    {action:choice('menu','order','cook','eat','sit','status','cancel'),dish:text,feeling:text}, ['action'], true),
  tool('furniture', 'Read Cabin World’s available custom furniture for the current resident.'),
  tool('update_plan', 'Read the available Cabin World modules. Module choices can be changed in Cabin World settings.'),
] satisfies Declaration[];

export function cabinArguments(name: string, supplied: Record<string, unknown>, actor: string) {
  const declaration = CABIN_TOOLS.find(tool => tool.name === name);
  if (!declaration) throw Error('Cabin World does not expose this command');
  const properties = declaration.parameters.properties as Record<string, unknown>;
  const args = Object.fromEntries(Object.entries(supplied).filter(([key]) => Object.hasOwn(properties,key)));
  return { ...args, ...(!['cabin_residents','cabin_update_plan'].includes(name) ? {actor} : {}), waitMs:0 };
}
