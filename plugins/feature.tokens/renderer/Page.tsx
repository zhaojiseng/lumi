import {useContentViews} from '../../../src/host/content-views';
import {ContentSurface} from '../../../src/host/content-surface';
export default function Tokens(){const {tokens,siteScope}=useContentViews();return <ContentSurface views={tokens} siteScope={siteScope} empty="暂无令牌来源"/>;}
