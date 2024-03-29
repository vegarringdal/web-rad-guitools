import { fetchStreamData } from "./fetchStreamData";
import { FilterArgument } from "@simple-html/datasource";
import { getDataControllerByName } from "./getDataControllerByName";
import { restApiCallEnd, restApiCallStart } from "./restApiCalls";
import { serviceCallback } from "./serviceCallback";
import { ServiceCallbackType } from "./ServiceCallbackType";
import { httpApiConfig } from "./httpApiConfig";
import { getApiConfig } from "./apiConfig";
import { reSelectCurrentEntityAndRefreshDs } from "./reSelectCurrentEntity";
import { getAccessToken } from "./getAzureAuth";
import { getModifiedFilter } from "./getModifiedFilter";

export class Service {
    callbackFn: ServiceCallbackType;
    dataControllerName: string;
    lastRequest: any;
    metaData: Record<string, any> = {};

    constructor(dataControllerName: string, callbackFn: ServiceCallbackType = serviceCallback) {
        this.dataControllerName = dataControllerName;
        this.lastRequest = null as any;
        this.callbackFn = callbackFn;
    }

    private generateQueryUrlParams(queryUrl: string, metaDataOnly: boolean) {
        const urlParams = new URLSearchParams();
        urlParams.append("rows", "0");

        if (metaDataOnly) {
            urlParams.append("meta", "1");
        }

        return `${queryUrl}?${urlParams.toString()}`;
    }

    private resetServiceState() {
        this.callbackFn({
            type: "info",
            header: "Connecting to database",
            content: "Updating grid, please wait",
            loadingDataRuntimeMilliseconds: 0,
            loadingDataReplyMilliseconds: 0,
            loadingDataRowCount: 0
        });
    }

    public getLastRequestTimestamp() {
        return new Date(this.lastRequest);
    }

    async loadAll(query?: FilterArgument, updateOnly = false) {
        restApiCallStart();
        this.resetServiceState();
        const controller = getDataControllerByName(this.dataControllerName);
        const apiName = getApiConfig(this.dataControllerName).api.apiName;
        const primaryKey = getApiConfig(this.dataControllerName).api.primaryKey;

        // override if we never have recived data from before
        updateOnly = updateOnly !== true ? false : this.lastRequest !== null;
        let useQuery = query;

        const primaryKeys: any[] = [];
        if (!updateOnly) {
            controller.dataSource.setData([]);
        } else {
            const modifiedColumn = getApiConfig(this.dataControllerName).api.modified;
            if (modifiedColumn) {
                useQuery = getModifiedFilter(query || null, modifiedColumn, this.getLastRequestTimestamp());
            }

            const rows = controller.dataSource.getAllData();
            rows.forEach((r: any) => {
                primaryKeys.push(r[primaryKey]);
            });
        }

        const error = await this.fetchData(
            this.generateQueryUrlParams(httpApiConfig.query_url + apiName, false),
            useQuery,
            primaryKeys,
            updateOnly
        );

        if (!error) {
            controller.dataSource.reloadDatasource();
            controller.dataSource.__callSubscribers("collection-sorted");
        }

        if (!error) {
            this.callbackFn({
                type: "done",
                header: null,
                content: null
            });
        }

        reSelectCurrentEntityAndRefreshDs(controller.dataSource, primaryKey);

        restApiCallEnd();
        this.callbackFn({
            type: "done",
            header: null,
            content: null
        });
    }

    /**
     * default update, lo logic, this needs to be done before and after
     * @param data
     * @returns
     */
    public async update(data: any[]) {
        restApiCallStart();
        // if no data, just return error and msg
        if (data && data.length) {
            // reset dialogs
            this.resetServiceState();
            const apiName = getApiConfig(this.dataControllerName).api.apiName;

            // get project code if any and genrate url
            const urlParams = new URLSearchParams();

            const fetchURL = `${httpApiConfig.update_url}${apiName}?${urlParams.toString() || ""}`;

            // call server with modified data
            const response = await fetch(fetchURL, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + (await getAccessToken())
                },
                body: JSON.stringify(data)
            });

            if (!response.ok || !response.body) {
                const result = await response.json();

                // if error show this
                if (!response.ok) {
                    this.callbackFn({
                        type: "error",
                        header: "Fetch error",
                        content: result.msg
                    });
                }

                // close dialog
                this.callbackFn({
                    type: "done",
                    header: null,
                    content: null
                });

                // rturn result
                return { success: false, data: [] };
            }

            // all ok, lets read progress of update

            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

            // TODO: clean up, just test experiment works first, give status back on large updates
            let isReading = true;
            let tempString = ""; // hold half data string if any
            let returnedIds: number[] = [];

            while (isReading) {
                // eslint-disable-next-line prefer-const
                let { value, done } = await reader.read();
                tempString = tempString + (value || "");

                // we can get last char, if its array, then we are in the end..
                const lastchar = tempString[tempString.length - 1];
                if (lastchar === "]") {
                    const jsonText = tempString.split(";");

                    if (jsonText) {
                        try {
                            returnedIds = JSON.parse(jsonText.pop() || "");
                        } catch (e) {
                            // just in case
                        }

                        isReading = false;
                    }
                }

                const tempVal = tempString.split(";");
                if (tempVal.length > 1) {
                    // we remove progress updates as we get them
                    // since we might end up with error and get json text back
                    tempString = tempVal.pop() || "";
                }

                this.callbackFn({
                    type: "info",
                    header: "Updating",
                    content: "updated :" + tempVal.shift() || ""
                });

                if (done) {
                    isReading = false;
                    // if we havent set returned IDs, then something is wrong
                    if (returnedIds.length === 0) {
                        const jsonText = tempString;
                        if (jsonText) {
                            try {
                                const result = JSON.parse(jsonText);
                                this.callbackFn({
                                    type: "error",
                                    header: "Update Error",
                                    content: result.msg // TODO maybe I should tell what rows that did OK ?
                                });
                            } catch (e) {
                                this.callbackFn({
                                    type: "error",
                                    header: "Update Error",
                                    content: "unknown error"
                                });
                            }
                            this.callbackFn({
                                type: "done",
                                header: null,
                                content: null
                            });
                            // rturn result
                            return { success: false, data: [] };
                        }
                    }
                }
            }

            restApiCallEnd();
            this.callbackFn({
                type: "done",
                header: null,
                content: null
            });

            return { success: response.ok, data: returnedIds };
        } else {
            restApiCallEnd();
            this.callbackFn({
                type: "done",
                header: null,
                content: null
            });
            return { success: false, data: "no changes" };
        }
    }

    private async fetchData(
        urlPathAndParams: string,
        query: FilterArgument | null | undefined,
        primaryKeys: string[] = [],
        updateOnly = false
    ) {
        const v0 = performance.now();
        const controller = getDataControllerByName(this.dataControllerName);
        const primaryKey = getApiConfig(this.dataControllerName).api.primaryKey;

        let fetchError = false;
        this.lastRequest = new Date();
        const rows: any = [];

        await fetchStreamData(urlPathAndParams, query, (res) => {
            if (res.type === "data") {
                rows.push(res.data);
            }

            if (res.type === "meta") {
                this.metaData = res.data;
            }

            if (res.type === "length") {
                this.callbackFn({
                    type: "info",
                    header: "Downloading data",
                    content: `Rows fetch: ${res.data}\nTime used: ${
                        (performance.now() - v0).toString().split(".")[0]
                    }ms`,
                    loadingDataRowCount: res.data
                });
            }

            if (res.type === "error") {
                fetchError = true;
                this.callbackFn({
                    type: "error",
                    header: "Fetch error",
                    content: res.data
                });
            }
        });

        const dataContainer = controller.dataContainer;
        if (!updateOnly && !primaryKeys.length) {
            dataContainer.setData(rows, true);
        } else {
            rows.forEach((row: any) => {
                // this will be slow..
                const index = primaryKeys.indexOf(row[primaryKey]);
                if (index !== -1) {
                    dataContainer.replace([row], index, 1);
                } else {
                    dataContainer.setData([row], true);
                }
            });
        }

        return fetchError;
    }
}
