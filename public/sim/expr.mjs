// 主数据条件表达式（如 `CountBC(IsPlayer()==1&&IsTeam(31A)==1)>=3`）的解析与求值。
// 只做纯语法：函数的含义由调用方传入的 functions 表决定；不认识的函数抛 UnsupportedCondition，
// 调用方据此把技能标为“不支持”，绝不静默当成真或假。

export class UnsupportedCondition extends Error{
  constructor(name,expr){super(`未支持的条件函数 ${name}（${expr}）`);this.fn=name;this.expr=expr;}
}

const OPS=['&&','||','==','!=','>=','<=','>','<','+','-','*','/','!','(',')',','];

export function tokenize(src){
  const out=[];let i=0;
  while(i<src.length){
    const c=src[i];
    if(/\s/.test(c)){i++;continue;}
    const op=OPS.find(o=>src.startsWith(o,i));
    // 数字（含小数）；注意 31A 这类标识符以数字开头
    const num=/^\d+(\.\d+)?(?![A-Za-z_0-9.])/.exec(src.slice(i));
    if(num){out.push({t:'num',v:Number(num[0])});i+=num[0].length;continue;}
    const id=/^[A-Za-z0-9_.]+/.exec(src.slice(i));
    if(id){out.push({t:'id',v:id[0]});i+=id[0].length;continue;}
    if(op){out.push({t:'op',v:op});i+=op.length;continue;}
    throw new SyntaxError(`无法解析条件 "${src}" 第 ${i} 个字符`);
  }
  return out;
}

// 优先级：|| < && < 比较 < 加减 < 乘除 < 一元
export function parse(src){
  const tk=tokenize(src);let p=0;
  const peek=()=>tk[p],eat=v=>{const t=tk[p];if(!t||(v&&t.v!==v))throw new SyntaxError(`条件 "${src}" 缺少 ${v||'表达式'}`);p++;return t;};
  const bin=(next,ops)=>()=>{let l=next();while(peek()?.t==='op'&&ops.includes(peek().v)){const op=eat().v;l={k:'bin',op,l,r:next()};}return l;};
  function primary(){
    const t=peek();
    if(!t)throw new SyntaxError(`条件 "${src}" 意外结束`);
    if(t.t==='op'&&t.v==='('){eat('(');const e=or();eat(')');return e;}
    if(t.t==='op'&&(t.v==='!'||t.v==='-')){eat();return {k:'un',op:t.v,e:primary()};}
    if(t.t==='num'){eat();return {k:'num',v:t.v};}
    if(t.t==='id'){
      eat();
      if(peek()?.v==='('){
        eat('(');const args=[];
        if(peek()?.v!==')'){args.push(or());while(peek()?.v===','){eat(',');args.push(or());}}
        eat(')');return {k:'call',name:t.v,args};
      }
      return {k:'id',v:t.v};
    }
    throw new SyntaxError(`条件 "${src}" 在 ${t.v} 处无法解析`);
  }
  const mul=bin(primary,['*','/']),add=bin(mul,['+','-']),cmp=bin(add,['==','!=','>=','<=','>','<']),and=bin(cmp,['&&']),or=bin(and,['||']);
  const ast=or();
  if(p!==tk.length)throw new SyntaxError(`条件 "${src}" 末尾有多余内容`);
  return ast;
}

const cache=new Map();
export function compile(src){
  if(!cache.has(src))cache.set(src,parse(src));
  return cache.get(src);
}

/**
 * 求值。functions[name](env, args, evalArg) 返回数字或布尔；
 * args 是未求值的语法树，evalArg(node, env2) 用来在另一个单位上下文里求值（CountBC 需要）。
 * 标识符参数（Fire、31A、RKayamori）以字符串传给函数。
 */
export function evaluate(src,env,functions){
  if(!src||!String(src).trim())return true;
  const ast=compile(String(src));
  const ev=(n,e)=>{
    switch(n.k){
      case 'num':return n.v;
      case 'id':return n.v;
      case 'un':{const v=ev(n.e,e);return n.op==='!'?!truthy(v):-num(v);}
      case 'bin':{
        if(n.op==='&&')return truthy(ev(n.l,e))&&truthy(ev(n.r,e));
        if(n.op==='||')return truthy(ev(n.l,e))||truthy(ev(n.r,e));
        const a=ev(n.l,e),b=ev(n.r,e);
        switch(n.op){
          case '==':return num(a)===num(b);case '!=':return num(a)!==num(b);
          case '>=':return num(a)>=num(b);case '<=':return num(a)<=num(b);
          case '>':return num(a)>num(b);case '<':return num(a)<num(b);
          case '+':return num(a)+num(b);case '-':return num(a)-num(b);
          case '*':return num(a)*num(b);case '/':return num(b)===0?0:num(a)/num(b);
        }
        break;
      }
      case 'call':{
        const fn=functions[n.name];
        if(!fn)throw new UnsupportedCondition(n.name,src);
        return fn(e,n.args,ev);
      }
    }
    throw new SyntaxError('未知语法节点');
  };
  return truthy(ev(ast,env));
}

/** 只列出表达式里用到的函数名，用于预先判断支持度。 */
export function functionsUsed(src){
  const out=new Set();
  const walk=n=>{if(!n)return;if(n.k==='call'){out.add(n.name);n.args.forEach(walk);}else if(n.k==='bin'){walk(n.l);walk(n.r);}else if(n.k==='un')walk(n.e);};
  if(src&&String(src).trim())walk(compile(String(src)));
  return [...out];
}

function num(v){return typeof v==='boolean'?(v?1:0):typeof v==='number'?v:Number(v)||0;}
function truthy(v){return typeof v==='boolean'?v:num(v)!==0;}
