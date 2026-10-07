/** Deployed EIP-1271 wallets only. No EIP-6492 factory/deployment simulation.
 * rpc is a trusted server callback using fixed per-chain URLs, not user URLs:
 *   async ({chainId,method,params,signal}) => raw JSON-RPC result
 * It MUST throw JSON-RPC errors and honor signal. At most five RPC calls, a
 * five-second total deadline, a 1m gas call cap, and a pinned block/hash check.
 */
import {encodeFunctionData,hashMessage} from 'viem';
import {AccountError} from './validation.js';
const ABI=[{type:'function',name:'isValidSignature',stateMutability:'view',inputs:[{name:'hash',type:'bytes32'},{name:'signature',type:'bytes'}],outputs:[{name:'magicValue',type:'bytes4'}]}];
const HEX_QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const HASH=/^0x[0-9a-f]{64}$/i;
const unavailable=()=>new AccountError(503,'signature_verifier_unavailable','Wallet signature verification is temporarily unavailable.');

export function createEip1271Verifier({rpc,allowedChains=[1,56,4663,8453,42161]}={}) {
  if(typeof rpc!=='function'||!Array.isArray(allowedChains)||!allowedChains.length||allowedChains.some(n=>!Number.isSafeInteger(n)||n<1)) throw new TypeError('Use a fixed server-side RPC callback and explicit allowed chain IDs.');
  const chains=new Set(allowedChains);
  return async function verifyDeployedWallet({address,chainId,message,signature,hash,signal}={}) {
    if(!chains.has(chainId)||typeof address!=='string'||!/^0x[0-9a-f]{40}$/i.test(address)||typeof message!=='string'||message.length>2048||typeof signature!=='string'||!/^0x(?:[0-9a-f]{2}){1,4096}$/i.test(signature)) return false;
    const digest=hashMessage(message);if(hash!==undefined&&hash!==digest)return false;
    const controller=new AbortController();const abort=()=>controller.abort();
    if(signal?.aborted)throw unavailable();signal?.addEventListener('abort',abort,{once:true});
    let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
    const read=async(method,params)=>{if(controller.signal.aborted)throw unavailable();return rpc({chainId,method,params,signal:controller.signal});};
    try {
      const verify=async()=>{
        const [reportedChain,block]=await Promise.all([read('eth_chainId',[]),read('eth_getBlockByNumber',['latest',false])]);
        if(typeof reportedChain!=='string'||!HEX_QUANTITY.test(reportedChain)||BigInt(reportedChain)!==BigInt(chainId))throw unavailable();
        if(!block||!HEX_QUANTITY.test(block.number)||!HASH.test(block.hash))throw unavailable();
        const code=await read('eth_getCode',[address,block.number]);
        if(code==='0x')return false;
        if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||code.length>524290)throw unavailable();
        let result;
        try {result=await read('eth_call',[{to:address,data:encodeFunctionData({abi:ABI,functionName:'isValidSignature',args:[digest,signature]}),gas:'0xf4240'},block.number]);}
        catch(error){if(error?.code===3||error?.code==='CALL_EXCEPTION'||/execution reverted|revert(?:ed)?\b/i.test(String(error?.message||'')))return false;throw error;}
        // bytes4 is ABI-padded to 32 bytes. Do not accept truthy strings, a
        // fallback's arbitrary output, or a bare/partially matching selector.
        if(typeof result!=='string'||!/^0x1626ba7e0{56}$/i.test(result))return false;
        const after=await read('eth_getBlockByNumber',[block.number,false]);
        if(!after||after.number!==block.number||typeof after.hash!=='string'||after.hash.toLowerCase()!==block.hash.toLowerCase())throw unavailable();
        return true;
      };
      return await Promise.race([verify(),deadline]);
    } catch(error){if(error instanceof AccountError)throw error;throw unavailable();}
    finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
}
