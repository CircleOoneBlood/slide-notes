## Bellman equation

$$V(x_k)=\min_{u_k}\Big[\ell(x_k,u_k)+V\big(f(x_k,u_k)\big)\Big]$$

$V(x_k)$ 是从状态 $x_k$ 出发、之后都按最优策略行动时的**最优剩余代价**（cost-to-go）。它等于“当前一步的代价 $\ell$”加上“走到下一状态 $x_{k+1}=f(x_k,u_k)$ 后的最优代价”。iLQR 不直接求解这个方程，而是在名义轨迹 $(\hat x_k,\hat u_k)$ 附近对右边做**二阶近似**，从而得到局部最优的修正量。