(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaskType = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TASK_TYPE_BY_CDK = {
    "[checkout-debug]": "链接调试",
    "[payment-debug]": "支付调试",
    "[custom-pay]": "自定义付款",
    "[self-pay]": "自助开通",
  };

  function getTaskType(task) {
    const cdk = String(task?.cdk || "");
    return TASK_TYPE_BY_CDK[cdk] || "CDK 开通";
  }

  return { getTaskType, TASK_TYPE_BY_CDK };
});
