type FilterValues = {filter:string;scope:string;mode:string;conditions?:{joiner:string;scope:string;mode:string;filter:string}[];protocols:string[];statuses:number[];device:string;application:string|null;library:string};
export function viewMatches(view:FilterValues|undefined|null,current:FilterValues|undefined|null):boolean;
export function matchingViewId(views:(FilterValues&{id:string})[],current:FilterValues,appliedId?:string):string;
export function describeView(view:FilterValues):string;
