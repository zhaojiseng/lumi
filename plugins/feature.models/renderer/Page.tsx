import {useContentViews} from '../../../src/host/content-views';
import {ContentSurface} from '../../../src/host/content-surface';
export default function Models(){const {models,siteScope}=useContentViews();return <ContentSurface views={models} siteScope={siteScope} empty="暂无模型来源"/>;}
